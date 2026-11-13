# P2：memory 试点（第一个功能插件）

- 前置：P1（G1 通过）
- 预计：1 个会话
- 质量门：G2（见 [PLAN.md](../PLAN.md) §7）
- 结果：业务行从 2 变 3：`study-core` + `study` shell + `study-memory`；memory 拥有独立客户端 bundle

## 目标

把 `memory` 从旧 shell 完整迁到 `plugins/study-memory`，验证四件事：

1. 第二个功能插件行可以只注入 `ctx.study` 就工作；
2. 独立客户端 bundle 能使用 core 的共享服务；
3. 可选事件（`study/learning/changed`）缺失时 memory 仍可用；
4. 禁用 memory 后其他功能不崩、页面显示不可用。

这是 P3–P6 的模板；把可复用的步骤写清楚，后面阶段照做。

## 开工前读

1. [AGENT.md](../AGENT.md)、[CONTRACTS.md](../CONTRACTS.md) 第 1/2/3/7 节
2. [ADR](../../../decisions/plugin-split.md) 第 5.2–5.4、6.1–6.4 节
3. `plugins/study/host/modules/memory.mjs`、`host/memory/*`
4. `plugins/study/client/pages/memory.js`、`client/messages/memory.js`
5. `plugins/study/tests/memory/*`
6. P1 的交付记录与 core 客户端服务签名

## 所有权

**新建/可改：**

- `plugins/study-memory/**`（host、client、tests、package.json、build 脚本）
- `plugins/study/host/index.mjs`（从模块列表/注册中移除 memory）
- `plugins/study/client/plugin.js`（移除 memory 页面注册）
- `plugins/study/client/messages/memory.js`、`client/pages/memory.js`（迁出后删除）
- `plugins/study/tests/memory/**`（迁出后删除）
- `scripts/project-config.mjs`（插入 memory 行）
- `CONTRACTS.md`、`STATUS.md`

**不可改：**

- memory 的业务逻辑/文案/工具名/方法名（只改装配方式）；
- 其他模块与页面；
- 数据库 schema（memory 现有表保持不变）；
- `source/deepseek-harness/`、`patches/`、`platform/`。

## 步骤

1. **基线。** 跑 `node --test plugins/study/tests/memory`；记录 memory 页面、工具、命名空间方法、事件监听、`memory.json` 迁移行为。备份 `plugins/study` 到 `.studybuddy/plugin-split-backup/P2/`。
2. **建包。** `plugins/study-memory/package.json`：
   - `name: "@studybuddy/study-memory"`、`private: true`、`type: "module"`；
   - `exports: { ".": "./host/index.mjs", "./client": "./client/client.js" }`；
   - `dsh.client.platform = "web"`；`dsh.client.inject = ["@studybuddy/study-core"]`。
3. **迁 host。**
   - 移动 `memory.mjs`、`host/memory/{migrate-v1,store,traits}.mjs`、测试。
   - 入口 `inject = ['study', 'tools']`；`systemPrompt` 用作用域内 `ctx.inject(['systemPrompt'], ...)` 注册提示词扩展，缺失时不要阻塞插件加载。
   - `apply`：先 `ctx.study.module({ id: 'memory', deps: [], schemaVersion, schema, readContracts })`，再 `ctx.study.register('memory', { methods, writes })`，再注册工具与 `systemPrompt` 扩展。
   - `resolveActiveGoal` 从 `packages/study-model` 引入；不要复制。
   - `study/learning/changed` 监听保留，但作为可选：事件不来时 memory 的所有方法仍工作。
4. **迁 client。**
   - 移动 `pages/memory.js`、`messages/memory.js`；`key: 'memory'`、`order: 80` 不变。
   - locale NS 改为 `study-memory`；`label: 'memory.panel'` 留在本插件字典；共享 `common.*` 从 `packages/study-messages` 合并。
   - 页面通过 core 的 `studyClient` 调用；不要 import shell 的 `lib/api.js`。
   - 侧栏入口由本插件注册（`sidebar.panellist`），图标用 core 的 `studyUi` 或最小本地实现。
5. **从 shell 移除。**
   - 删除 `host/modules/memory.mjs` 的发现/注册（文件迁走）；
   - 删除 shell 的 memory 页面注册、字典合并、测试目录；
   - 确认 shell 的 `messages/memory.js` 不再被 barrel 引用。
6. **profile。**
   - 插入 `study-memory` 行（包名或绝对路径，按 P1 的 dev 方式）；
   - 行顺序：`study-core` → `study` → `study-memory` 或 `study-core` → `study-memory` → `study` 均可，但必须在 CONTRACTS 记录；推荐 core → shell → memory，保持 shell 先提供其余命名空间。
7. **测试。**
   - memory 测试迁到 `plugins/study-memory/tests`，只改 import；
   - 增加/保留：
     - 无 learning 事件时 `remember/recall/forget/profileGet` 正常；
     - memory 命名空间只在插件启用时存在；
     - 禁用 memory 行后应用启动，questions/plan/outcomes 页面不受影响；
     - 页面 key/locale NS 不与 shell 冲突。
   - 跑 memory 目录 + shell 目录 + 工程测试。
8. **冒烟。**
   - 启动应用：记忆页可达、侧栏 order 80、工具在会话中可见（或按现有测试方式验证）；
   - 关闭 memory 行，重启：记忆页消失、其他页正常；
   - 重新启用：数据仍在、页面恢复。

## 验收（G2）

- [ ] `study-memory` 独立行、独立 bundle、独立 locale NS；
- [ ] memory 页面/方法/工具行为与基线一致；
- [ ] 无 `study/learning/changed` 事件时 memory 正常；
- [ ] 禁用 memory 后其他功能正常，页面不崩；
- [ ] 测试从 shell 迁出后全量通过；
- [ ] CONTRACTS 的插件表、表所有权、读契约（`study_goal`）、页面行已更新；
- [ ] 没有跨插件 import、没有 shell 的 memory 残留注册。

## 明确不做

- 不改 memory 的业务规则、文案、工具 schema；
- 不迁移 learning/outcomes；
- 不把 memory 做成独立数据库；
- 不删除旧 shell。

## 回退

- 停止应用；把备份的 `plugins/study` 恢复；删除 `plugins/study-memory`；profile 行改回；重启验证。
- 如果只是 memory 行有问题，可以先在 profile 禁用该行，让产品回到 P1 状态。

## 交付记录

在 STATUS 追加 P2 记录；在本文件末尾写：

```md
## 下一阶段注意事项
- 可复用的建包/构建/注册模板：
- memory 与 facts 的读契约实际用法：
- 事件缺失/禁用插件的实际表现：
- P3 迁移 facts 时需要先处理的共享代码：
```
