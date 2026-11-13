# P4：抽出 study-learning

- 前置：P3（G3 通过）
- 预计：1 个会话
- 质量门：G4（见 [PLAN.md](../PLAN.md) §7）
- 结果：业务行从 4 变 5：core + facts + learning + memory + shell；shell 只剩 reminders/outcomes

## 目标

把答疑、问答单元、学习证据、周报/月报迁到 `plugins/study-learning`：

- host：`tutoring`、`learning`、`review` 三个模块与 `host/learning/*` 辅助；
- client：`questions` 页面、`messages/questions.js`；
- 事件：发布 `study/learning/changed`；消费 `agent/inbox/claimed` 等 host 事件。

## 开工前读

1. [AGENT.md](../AGENT.md)、[CONTRACTS.md](../CONTRACTS.md) 第 2/3/4/5/7 节
2. [ADR](../../../decisions/plugin-split.md) 第 3.2、5.2、6.1–6.4 节
3. `plugins/study/host/modules/{tutoring,learning,review}.mjs`、`host/learning/*`
4. `plugins/study/client/pages/questions.js`、`client/messages/questions.js`
5. `plugins/study/tests/{learning,review,tutoring}/`
6. P3 的交付记录

## 所有权

**新建/可改：**

- `plugins/study-learning/**`
- `plugins/study/host/index.mjs`（移除三个模块注册）
- `plugins/study/client/plugin.js`（移除 questions 页面注册）
- `client/pages/questions.js`、`client/messages/questions.js`（迁出后删除）
- `plugins/study/tests/{learning,review,tutoring}/`（迁出后删除）
- `scripts/project-config.mjs`（插入 learning 行）
- `CONTRACTS.md`、`STATUS.md`

**不可改：**

- learning/tutoring/review 的业务规则、文案、方法名、工具名、schema；
- facts/memory 插件；
- shell 中 reminders/outcomes 的逻辑（只改 import 与装配）；
- `source/deepseek-harness/`、`patches/`、`platform/`。

## 步骤

1. **基线。** 跑 learning/review/tutoring 测试；记录 questions 页面、三个命名空间、工具、事件、schema；备份 `plugins/study` 到 `.studybuddy/plugin-split-backup/P4/`。
2. **建包。** `plugins/study-learning/package.json`，名称 `@studybuddy/study-learning`，`exports["./client"]`，`dsh.client.inject = ["@studybuddy/study-core"]`。
3. **迁 host。**
   - 移动三个模块与 `host/learning/*`；入口 `inject = ['study', 'tools']`；按模板注册三个 schema/命名空间/工具。
   - `learning` 的 `ctx.on('agent/inbox/claimed')`、`tutoring` 的 `agent/created` 保留；事件名不变。
   - `study/learning/changed` 的发布保留；consumer（memory）已在 P2 独立存在，验证事件仍到达。
   - `review` 读 learning 表；同插件内部，不算跨插件契约。
4. **迁 client。**
   - 移动 questions 页面/messages；`key: 'questions'`、`order: 70` 不变。
   - locale NS 用 `study-learning`；共享文案从 `packages/study-messages` 合并。
   - 页面通过 core 的 `studyClient`；侧栏入口由本插件注册。
   - `learning-notify.js` 先留在 shell：它被 reminders 页使用，P5 随 reminders 迁走；不要在这里移动或复制。
5. **从 shell 移除。**
   - 删除三个模块文件/注册、questions 页面、messages；
   - shell 只剩 reminders/outcomes 页面与对应模块（以及 `learning-notify.js`）；
   - 更新 barrel/字典，确保无悬空 import。
6. **profile。**
   - 插入 `study-learning` 行；推荐顺序：`study-core` → `study-facts` → `study-learning` → `study-memory` → `study`。
   - 记录实际顺序到 CONTRACTS。
7. **测试。**
   - 测试迁到 `plugins/study-learning/tests`，只改 import；
   - 增加：questions 页面 key/order/NS 唯一；禁用 learning 时 outcomes 页的报告区显示不可用（shell 中的 outcomes 页面在 P6 才迁出，这里先验证不崩）；memory 收不到事件时仍正常；
   - 跑 learning + facts + memory + shell + 工程测试。
8. **冒烟。**
   - 启动：问答页可达、问答单元列表/合并/拆分、周报/月报、答疑上下文注入正常；
   - 从一次学习会话触发 `study/learning/changed`，memory 侧无异常；
   - 禁用 learning 行（测试 profile）→ 应用启动，questions 页消失，facts/reminders/memory 正常，outcomes 页报告区降级。

## 验收（G4）

- [ ] `study-learning` 独立行/独立 bundle/独立 NS；
- [ ] questions 页、review、tutoring 上下文与基线一致；
- [ ] `study/learning/changed` 仍发布并被 memory 消费；
- [ ] shell 只剩 reminders/outcomes；
- [ ] 禁用 learning 时其他功能正常，相关区域降级；
- [ ] 测试迁出后全量通过；
- [ ] CONTRACTS 的命名空间/表/事件/页面行已更新；
- [ ] 无跨插件业务 import、无跨插件写。

## 明确不做

- 不迁移 reminders/outcomes；
- 不改学习数据模型、切分算法、报告模板；
- 不新增模型调用；
- 不删除旧 shell。

## 回退

- 停止应用；恢复备份的 `plugins/study`；删除 `plugins/study-learning`；profile 行改回；重启验证。
- 若只是 learning 行有问题，先禁用该行回到 P3 状态。

## 交付记录

在 STATUS 追加 P4 记录；在本文件末尾写：

```md
## 下一阶段注意事项
- learning 实际行顺序与事件表现：
- questions 页面 NS/order/共享文案：
- shell 剩余内容：
- outcomes 迁移时对 review 的软依赖处理：
```
