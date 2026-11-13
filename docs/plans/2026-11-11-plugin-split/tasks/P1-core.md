# P1：抽出 study-core 与共享库

- 前置：P0（G0 通过）
- 预计：1.5–2 个会话；允许拆成 **P1a（host）** 与 **P1b（client）**，两段都完成才算 P1 DONE
- 质量门：G1（见 [PLAN.md](../PLAN.md) §7）
- 结果：业务行从 1 变 2：`study-core` + 旧 `study` shell；core 拥有 DB/kernel/路由/客户端公共服务；shell 继续承载其余模块与页面

## 目标

1. 把 `db`、`kernel`、`registry`、路由、导出、`ctx.study` 从旧 shell 抽到 `plugins/study-core`。
2. 把 `StudyError`/错误码/命名空间/日期/请求 id、`facts` 读模型抽到 `packages/study-contracts` 与 `packages/study-model`。
3. 把客户端共享能力（api/refresh/页面恢复/面板图标）抽到 core 客户端，并提供 `studyClient` / `studyRefresh` / `studyNav` / `studyUi` 服务。
4. 旧 shell 改成“注入 `ctx.study`、注册自己的模块、使用 core 客户端服务”的普通业务插件。
5. **页面、路由、工具、数据、文案、order 均不变。**

## 开工前读

1. [AGENT.md](../AGENT.md)、[CONTRACTS.md](../CONTRACTS.md) 第 1/2/3/6/7 节
2. [ADR](../../../decisions/plugin-split.md) 第 3.1、3.4、3.5、5.2、5.3 节
3. `plugins/study/host/index.mjs`、`db.mjs`、`kernel.mjs`、`registry.mjs`、`facts.mjs`
4. `plugins/study/client/plugin.js`、`lib/*.js`、`pages/today.js`、`messages/today.js`
5. `scripts/project-config.mjs`、`.studybuddy/home/cordis.patch.yml`

## 所有权

**新建/可改：**

- `packages/study-contracts/**`
- `packages/study-model/**`
- `packages/study-messages/**`（common/daily 共享字典）
- `plugins/study-core/**`
- `plugins/study/host/index.mjs`（改成 shell 入口）
- `plugins/study/host/modules/export.mjs`（迁到 core）
- `plugins/study/client/plugin.js`、`client/lib/*.js`（状态型单例改造）
- `plugins/study/client/pages/today.js`、`client/messages/today.js`、`client/actions/refresh.js`（迁到 core）
- `plugins/study/scripts/build-client.mjs`（如需支持多包构建）
- `scripts/project-config.mjs`（只改 `deploymentPolicy` 的插入行）
- `scripts/backup-studybuddy.mjs`（`export.mjs` 迁走后更新 import）
- `docs/backup.md`（只改 db/export 路径引用）
- `plugins/study/tests/kernel/**`（迁到 core 或更新 import）
- `docs/plans/2026-11-11-plugin-split/CONTRACTS.md`、`STATUS.md`

**不可改：**

- 除 `export.mjs` 外的其他 `host/modules/*.mjs`（P2–P6 再动；如果 import 路径必须改，只改 import 行，不改逻辑）
- 除 `today` 外的页面与文案（只改它们使用 `call`/`refresh` 的方式）
- `source/deepseek-harness/`、`patches/`、`platform/`
- 数据库 schema 与 `schemaVersion`

## 开工前基线

```powershell
# 1. 备份旧 shell（被忽略目录，不提交）
$backup = ".studybuddy/plugin-split-backup/P1"
New-Item -ItemType Directory -Force $backup | Out-Null
Copy-Item -Recurse -Force plugins/study "$backup/study"

# 2. 记录基线
node --test plugins/study/tests
node --test tests/project/config.test.mjs tests/project/credentials.test.mjs tests/project/import-errors.test.mjs

# 3. 启动应用，记录：页面列表、侧栏 order、命名空间方法数、工具数、导出一份 JSON
```

把基线结果写进 STATUS；任何一项不通过，先停下修基线，不要带着红基线拆分。

## 步骤

### P1a：host 与共享库

1. **建共享库 `packages/study-contracts` 与 `packages/study-messages`。**
   - contracts 迁入：`StudyError`、`ERROR_CODES`、`NAMESPACES`、`isPlainObject`、`localDate`（从 `kernel.mjs` 拆出）、`toolRequestId`（从 `operation.mjs` 拆出，或放 model 库）。
   - messages 迁入 `client/messages/common.js` 与 `daily.js`；core 与 shell 的构建都把共享字典合并进自己的 locale NS，避免复制。
   - `registry.mjs` 的 `createRegistry` / `assertNamespace` / `normalizeImplementation` 留在 core（它们依赖命名空间注册语义），只从 contracts 取常量和错误类。
   - 更新所有模块的 import；不改行为。
2. **建 `packages/study-model`。**
   - 迁入 `host/facts.mjs`（`resolveActiveGoal`、`itemLink`、`materializePlan`、`livePlanData` 等）。
   - 它依赖 `StudyError` 与数据库 handle；不要依赖 core 的内部实现。
   - 更新 materials/plans/followup/learning/tutoring/outcomes/tasks/memory 的 import。
3. **建 `plugins/study-core` host。**
   - 迁入 `db.mjs`、`kernel.mjs`、`registry.mjs`、`index.mjs` 的组装逻辑、`modules/kernel.mjs`、`modules/export.mjs`。
   - `Config` 只保留 `dataDir`；`inject = ['tools']`；路由等待 `connection`。
   - 提供 `ctx.study`：
     - `register(ns, impl)`：注册命名空间并挂路由；
     - `call(ns, method, payload, opts)`：同现有语义；
     - `module({ id, deps, schemaVersion, schema, readContracts })`：注册 DDL/版本/读契约；
     - `has(ns)`：能力探测；
     - `kernel`：给同进程业务模块用的共享句柄（`database`、`status()`、`recordChange`、`setDaySnapshotProvider` 等）。P1 先兼容现有模块；**写边界靠 CONTRACTS + 测试约束，运行期包装是后续硬化项**，不要宣称已经强制隔离。
   - **模块注册语义**：
     - 已记录且版本不同的模块 → 只让该插件失败（`unavailable` + 备份指引），不阻塞其他插件；
     - 未记录的模块 → 在事务中执行 DDL，写 `module_schema`；
     - `deps` 只用于顺序/诊断/`has`，不要假装 Cordis 会强制顺序；bundle 行序 + 组合测试负责顺序。
   - `kernel.status()` 动态报告已注册模块，而不是启动时的静态列表。
   - 首次加载不要无条件写当天快照；保留每次调用前的 `ensureDaySnapshot`，并在验收里确认 outcomes 的 provider 已注册后再产生首份快照。若出现竞态，在本阶段加“组合就绪”屏障，不要留给 P3。
4. **改旧 shell host。**
   - 删除打开 DB、`verifyModules`、`ctx.provide('study')`、`kernel.close` 等核心职责。
   - 改为 `inject = ['study', 'tools']`（模块仍要注册工具）；在 `apply` 中对 `host/modules/*.mjs` 每个定义调用 `ctx.study.module(...)`，然后 `ctx.study.register(...)` / 工具注册。
   - 保留自动发现与拓扑排序（`deps` 校验仍然有用）；不要直接 import core 的 db/kernel。
   - 删除 `export.mjs` 的 shell 注册（它已在 core）。
5. **改 profile。**
   - `deploymentPolicy` 插入 `study-core` 行，`config.dataDir` 指向原数据目录；旧 `study` 行保留，不再传 `dataDir`。
   - 行顺序：`study-core` 在 `study` 之前；`a02-probe` 暂时保留（P7 删）。
   - 不改模型配置与凭据策略。

### P1b：客户端共享服务

6. **建 core 客户端。**
   - 迁入 `client/lib/api.js`（→ `studyClient`）、`refresh.js`（→ `studyRefresh`）、`study-page.js`（→ `studyNav`）、`panel-icon.js`（→ `studyUi` 的一部分）、`pages/today.js`、`messages/today.js`、`actions/refresh.js`。
   - core 需要自己的最小 action registry（或共享纯函数），让 today 页的 `refresh-today` 动作可用；不要依赖 shell 的 registry。
   - 在 `apply` 中 `ctx.provide('studyClient', ...)`、`ctx.provide('studyRefresh', ...)`、`ctx.provide('studyNav', ...)`；`studyUi` 可选。
   - locale NS 用 `study-core`；页面 `today` order 20；侧栏入口由 core 注册。
   - `package.json`：`name: "@studybuddy/study-core"`、`exports["./client"]`、`dsh.client.platform = "web"`。
   - 用独立 building script 生成 `client/client.js`，`__ModuleLoader__.load` 的 id 必须等于包名。
7. **改 shell 客户端。**
   - `dsh.client.inject` 增加 `@studybuddy/study-core`；运行时 `inject` 增加 `studyClient` / `studyRefresh` / `studyNav`。
   - `plugin.js` 不再创建 `createStudyCall()`、`rememberLastPage()` 的本地单例；改用 core 服务。
   - 页面拿到的 `call` 改为 `studyClient.call`；`notifyStudyDataChanged`/`onStudyDataChanged` 改为 `studyRefresh`；`installStudyPageRestore` 改为 `studyNav`。
   - 删除 shell 的 `today` 页面与 `messages/today.js`；shell 字典不再合并 today 键。
   - 删除 shell 的 `actions/refresh.js`（已迁 core）；shell 的 action registry 不再包含 `refresh-today`。
   - 页面 key、order、其它文案保持不变。
8. **构建与测试。**
   - 若 `build-client.mjs` 只能构建单包，抽一个共享构建函数，按插件目录生成 barrel + `client.js`；不要复制两份构建逻辑。
   - 构建时把 `packages/study-messages` 的共享字典合并进每个插件的 locale NS（core 至少合并 common；shell 合并 common/daily）。
   - 更新 `plugins/study/tests/kernel/*` 的 import；core 的测试迁到 `plugins/study-core/tests/kernel/*`，只改 import，不改断言。
   - 跑：core 测试、shell 测试、工程测试、客户端构建测试。
9. **更新 backup 脚本与文档。**
   - `scripts/backup-studybuddy.mjs` 的 `exportModule` 动态 import 改为 core 的 `export.mjs`；注释里的路径同步更新。
   - `docs/backup.md` 中 `plugins/study/host/db.mjs`、`plugins/study/host/modules/export.mjs` 等路径改为 core；测试命令里的旧路径按本阶段结果更新。
   - 跑 `node scripts/backup-studybuddy.mjs --drill`，确认导出/恢复交叉核对仍通过（需要源码树依赖，只用于开发验收）。

## 验收（G1）

- [ ] profile 中 `study-core` + `study` 两行都能加载；`kernel.status` 报出两个插件的模块；
- [ ] 只有 core 打开 `study.db`；shell 没有 `new DatabaseSync` / 文件路径直连；
- [ ] 页面列表、order、文案、路由、工具与基线一致（today 由 core 注册，但外观/位置不变）；
- [ ] 写操作仍带 `requestId`，重复请求返回首次结果；revision/change_log 不变；
- [ ] 当天快照仍包含 outcomes 数据（或记录竞态并已加屏障）；
- [ ] 导出 JSON 内容与基线可比；
- [ ] `node scripts/backup-studybuddy.mjs --drill` 通过（export 模块迁移后仍可被备份脚本加载）；
- [ ] 现有测试全绿（允许只改 import，不允许削弱断言）；
- [ ] 应用可启动，登录/模型设置/对话不受影响。

## 明确不做

- 不拆 facts（tasks/plans 仍在一个 shell 里）；
- 不新增页面/文案/工具；
- 不 bump schema；
- 不删除旧 shell；
- 不迁移 memory/learning/outcomes/reminders；
- 不清理 `a02-probe`（P7）。

## 回退

- 停止应用；把 `.studybuddy/plugin-split-backup/P1/study` 复制回 `plugins/study`；删除 `plugins/study-core` 与 `packages/*`（如果用户同意）；把 `deploymentPolicy` 恢复为单 `study` 行；重启验证。
- 不要用 `git reset`；外层没有提交历史。

## 交付记录

在 STATUS 追加 P1 记录；在本文件末尾写：

```md
## 下一阶段注意事项
- core 行 id / 包名 / dataDir 配置：
- 模块注册 API 的实际签名与失败行为：
- 客户端服务实际签名：
- 已知竞态或未解决问题：
- P2 可以直接复用的模式：
```
