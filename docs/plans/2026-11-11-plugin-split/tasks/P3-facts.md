# P3：抽出 study-facts（业务基础）

- 前置：P1、P2（G1/G2 通过）
- 预计：1.5 个会话；允许拆成 **P3a（host）** 与 **P3b（client）**
- 质量门：G3（见 [PLAN.md](../PLAN.md) §7）
- 结果：业务行从 3 变 4：`study-core` + `study-facts` + `study-memory` + 旧 shell；shell 只剩 learning/reminders/outcomes

## 目标

把目标/资料/任务/计划/计时这一整块“学习事实与计划执行”迁到 `plugins/study-facts`，包括：

- host：`materials`、`plans`、`planning`、`tasks`、`timer` 五个模块与各自 schema/工具；
- client：`onboarding`、`plan`、`workbench`、`timer` 四个页面与文案；
- 共享读模型：`packages/study-model`（P1 已建，这里只更新 import）。

**不拆 tasks/plans**：两者存在表级数据环（tasks 读 goals，plans 写 tasks），本阶段保持同一插件。

## 开工前读

1. [AGENT.md](../AGENT.md)、[CONTRACTS.md](../CONTRACTS.md) 第 2/3/4/7 节
2. [ADR](../../../decisions/plugin-split.md) 第 3.2、3.3、5.3、8 节
3. `plugins/study/host/modules/{materials,plans,planning,tasks,timer}.mjs`
4. `plugins/study/client/pages/{onboarding,plan,workbench,timer}.js` 与对应 messages
5. `plugins/study/tests/{materials,plans,planning,tasks,progress,timer}/`
6. P2 的交付记录（建包/构建/注册模板）

## 所有权

**新建/可改：**

- `plugins/study-facts/**`
- `plugins/study/host/index.mjs`（移除 facts 模块注册）
- `plugins/study/client/plugin.js`（移除四个页面注册）
- 上述四个页面与 messages（迁出后删除）
- `client/lib/storage.js`、`lib/workspaces.js`、`lib/plan-creation.js`（随页面迁入 facts）
- `client/actions/ask-task.js`、`client/messages/tutoring.js`（workbench 的“问这道题”动作，随页面迁入 facts）
- 上述测试目录（迁出后删除）
- `packages/study-model/**`（如迁移中发现需要补纯函数）
- `scripts/project-config.mjs`（插入 facts 行）
- `CONTRACTS.md`、`STATUS.md`

**不可改：**

- facts 模块的业务规则、文案、方法名、工具名、schema；
- memory 插件；
- shell 中 learning/reminders/outcomes 的逻辑（只改 import 路径与装配）；
- `source/deepseek-harness/`、`patches/`、`platform/`。

## 步骤

1. **基线。** 跑 facts 相关测试（materials/plans/planning/tasks/progress/timer）；记录四个页面、命名空间方法、工具、schema；备份 `plugins/study` 到 `.studybuddy/plugin-split-backup/P3/`。
2. **建包。** `plugins/study-facts/package.json`：
   - `name: "@studybuddy/study-facts"`；
   - `exports: { ".": "./host/index.mjs", "./client": "./client/client.js" }`；
   - `dsh.client.platform = "web"`；`dsh.client.inject = ["@studybuddy/study-core"]`。
3. **迁 host。**
   - 移动五个模块到 `host/modules/`；入口按 P2 模板：`inject = ['study', 'tools']`；`apply` 中逐个 `ctx.study.module(...)` → `ctx.study.register(...)` → 工具注册。
   - `planning` 继续监听 `agent/pre-step`；`outcomes` 的当天快照 provider 不在本插件（P6）。
   - `facts.mjs` 的 import 改到 `packages/study-model`；不要在 facts 内复制 model。
4. **迁 client。**
   - 移动四个页面、四个 messages；`key/order` 保持：`onboarding=1`、`workbench=10`、`timer=15`、`plan=16`。
   - 同时移动页面依赖的 `lib/storage.js`、`lib/workspaces.js`、`lib/plan-creation.js`；`onboarding` 与 `plan` 之间的相对 import 保持在 facts 内。
   - 移动 `actions/ask-task.js` 与 `messages/tutoring.js`（`tutoring.ask*` 文案只服务这个动作）；workbench 的“问这道题”按钮必须继续可用。
   - `plan.js`/`workbench.js` 不再 import `lib/refresh.js`，改用 core 的 `studyRefresh`。
   - locale NS 用 `study-facts`；共享 `common.*` / `daily.*` 从 `packages/study-messages` 合并。
   - 页面使用 core 的 `studyClient` / `studyRefresh` / `studyNav`；不要 import shell 的 lib。
   - 侧栏入口、页面恢复由本插件注册；`study.layout.page` 的旧 key 必须仍能恢复。
5. **从 shell 移除。**
   - 删除 facts 模块文件与注册；删除四个页面、对应 messages、`actions/ask-task.js`、`messages/tutoring.js`、`lib/storage.js`、`lib/workspaces.js`、`lib/plan-creation.js`；
   - shell 的 `plugin.js` 只保留 learning/reminders/outcomes 页面；`refresh.js` 已由 P1 移除；
   - 更新 barrel/字典，确保没有悬空 import。
6. **profile。**
   - 插入 `study-facts` 行；推荐顺序：`study-core` → `study-facts` → `study-memory` → `study`（shell）。
   - 记录实际顺序到 CONTRACTS；不要依赖 Cordis 的隐式顺序。
   - 已知临时状态：P3–P4 期间 facts 的 `plan=16` 与 shell 的 `reminders=16` 跨插件同 order，侧栏顺序由行序/注册序决定；P5 把 reminders 改为 17 后消除。不要在本阶段改 reminders 的 order（它不属于 facts），但要在验收记录实际顺序。
7. **测试。**
   - 把 facts 测试迁到 `plugins/study-facts/tests`，只改 import；
   - 增加：四个页面 key/order/NS 唯一；facts 命名空间只在启用时存在；禁用 facts（仅测试环境）时 shell 的 learning/reminders/outcomes 给出明确不可用；
   - 跑 facts + memory + shell + 工程测试。
8. **冒烟。**
   - 启动：引导/计划/工作台/计时四页可达、拖拽/记录/计划创建正常；
   - 导出 JSON 与 P2 基线可比；schema 没有变化；
   - 禁用 facts 行（测试 profile）→ 应用启动，相关页面显示不可用，memory 正常。

## 验收（G3）

- [ ] `study-facts` 独立行/独立 bundle/独立 NS；
- [ ] 四页行为、文案、order 与基线一致；工作台“问这道题”动作、计划创建对话仍可用；
- [ ] facts 的五个命名空间、工具、schema 与基线一致（表/索引/触发器不变）；
- [ ] shell 只剩 learning/reminders/outcomes；
- [ ] memory 仍正常；facts 被禁用时明确不可用；
- [ ] 测试迁出后全量通过；
- [ ] CONTRACTS 的表所有权/读契约/页面行已更新；
- [ ] 无跨插件业务 import、无跨插件写。

## 明确不做

- 不拆 tasks/plans（ADR 第 8 节前置条件未满足）；
- 不迁移 learning/reminders/outcomes；
- 不改 schema 或数据迁移；
- 不删除旧 shell。

## 回退

- 停止应用；恢复备份的 `plugins/study`；删除 `plugins/study-facts`；profile 行改回；重启验证。
- 若只是 facts 行有问题，可先禁用 facts 行回到 P2 状态（memory 仍可用）。

## 交付记录

在 STATUS 追加 P3 记录；在本文件末尾写：

```md
## 下一阶段注意事项
- facts 实际行顺序与加载表现：
- 四个页面的 NS/order/共享文案处理：
- shell 剩余内容：
- learning 迁移时需要注意的跨插件读：
```
