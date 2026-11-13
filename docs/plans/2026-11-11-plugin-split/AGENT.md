# AGENT：插件拆分每个会话先读这一份

任务卡在 [`tasks/`](tasks/)，状态在 [`STATUS.md`](STATUS.md)，契约在 [`CONTRACTS.md`](CONTRACTS.md)，总体计划在 [`PLAN.md`](PLAN.md)。本文件只写“所有阶段都通用”的规则。

## 一分钟开工

1. 读本文件、你的任务卡、[CONTRACTS.md](CONTRACTS.md) 和 [STATUS.md](STATUS.md)。
2. 在 STATUS 确认任务卡的前置阶段都是 DONE/REVIEW；不满足就停，写 BLOCKED。
3. 只改任务卡“所有权”列出的路径；越界改动视为未完成。
4. 先跑基线命令，再改；每完成一个可验证的小步就跑相关测试。
5. 结束前更新 CONTRACTS、STATUS 和任务卡末尾的“下一阶段注意事项”。

## 当前仓库地图

```text
plugins/study/                 当前唯一业务插件（host + client + tests）；P1 起是“旧 shell”
platform/windows-credentials/  DPAPI 凭据插件（不动）
scripts/                       启动器、部署策略、备份脚本
patches/                       对 DSH 源码的补丁（本计划不动）
tests/project/                 工程级测试
source/deepseek-harness/       固定 DSH 源码；不要改
.studybuddy/                   本地运行数据（被 .gitignore 忽略）
docs/decisions/plugin-split.md 拆分 ADR（依赖模型的来源）
```

P1 起新增（按阶段逐步出现）：

```text
packages/study-contracts/      StudyError、错误码、命名空间、日期/请求 id 等纯契约
packages/study-model/          facts 读模型、materializePlan、operation
packages/study-messages/       客户端共享字典（common/daily）
packages/test-support/         测试夹具、React 桩（P1/P2 按需建立）
plugins/study-core/            L0 内核插件
plugins/study-facts/           L1 业务基础
plugins/study-learning/        L2 功能
plugins/study-memory/          L2 功能
plugins/study-reminders/       L2 功能
plugins/study-outcomes/        L3 功能
packages/study-bundle/         C 组合补丁层（不是插件行）
skills/study-creator/          Creator skill 内容（P6 从 plugins/study/creator 迁入）
tests/creator/                 Creator 验证脚本与证据（P6 迁入）
```

本计划**不引入根 workspace**：共享库先用相对路径 import；P7 评估 bundle 安装时再决定是否改成包名/`link:`。不要擅自新增根 `package.json`、锁文件或 pnpm workspace。

## 五条硬规则

1. **单库单 kernel。** 只有 `study-core` 打开 `study.db`、提供 `ctx.study`。其他插件通过 `ctx.study.call` / `ctx.study.module` / 只读表契约协作；不得自己 `new DatabaseSync`、不得读 `study.db` 文件。业务插件可以使用 core 提供的共享 `kernel.database` 句柄执行本插件表的 SQL，但**只能写自己拥有的表**；跨插件写必须走拥有者的服务。
2. **写只能由表的拥有者执行。** 跨插件写走拥有者的服务方法；不要 import 另一个插件的业务实现（会把“禁用插件”变成假动作）。共享纯函数放 `packages/study-model`。
3. **读可以直接 SQL，但必须登记。** 在 CONTRACTS 的“表所有权/读契约”里写清表、列、用途、版本；拥有者改 schema 时跑消费者测试。稳定的粗读优先用服务方法。
4. **客户端一插件一个 locale 命名空间。** `ctx.locale.register` 对同一 NS 的同一语种重复注册会抛错；不要多个插件共用 `study` NS。页面 key 全局唯一，侧栏 order 全局唯一；共享文案走 `packages/study-messages`。
5. **启停必须可信。** `study-core`、`study-facts` 是基础插件，产品内不可关闭；`learning`、`memory`、`outcomes`、`reminders` 可关闭，关闭后对应页面/工具消失、其他功能正常、页面显示“不可用”而不是崩溃。

## Host 侧约定

- 插件入口导出 `name`、`inject`、`Config`、`apply(ctx, config)`。
- 功能插件 `inject` 只写自己真正必需的服务：通常是 `['study', 'tools']`。`systemPrompt` 这类“有就贡献、没有也能跑”的服务用作用域内 `ctx.inject`，不要放进顶层 `inject`，否则服务缺失时整个插件不加载。
- **可选依赖不要写进 `inject`**（Cordis 的 `inject` 是必需语义）。可选依赖用 `ctx.get(name)`、`ctx.study.has(ns)` 或事件。
- 业务插件在 `apply` 里先调用 `ctx.study.module({ id, deps, schemaVersion, schema, readContracts })` 注册自己的 DDL/版本，再 `ctx.study.register(ns, impl)` 注册命名空间。
- 路由由 core 统一提供；功能插件不各自注册 `/api/study/...`。工具用 `ctx.tools.register(defineTool(...))`，工具名全局唯一。
- 不 bump 既有模块的 `schemaVersion`，除非任务卡明确要求；新模块用 1。改表必须同时更新 `readContracts` 版本。
- 不要把 `a02-probe`、布局探针、生成插件混进产品组合；P7 统一清理。

## 客户端约定

- 每个插件一个客户端 bundle：`dsh.client.platform = "web"`、`exports["./client"]`、`build-client` 产物。
- 功能插件的客户端在 `dsh.client.inject` 中声明 `@studybuddy/study-core`；运行时通过 `ctx.inject(['studyClient', ...])` 获取共享服务。
- 共享服务由 core 客户端提供：
  - `studyClient`：`call(ns, method, payload)` + 写操作 `requestId` 幂等；
  - `studyRefresh`：数据变更总线，替代 `client/lib/refresh.js` 的模块级 `Set`；
  - `studyNav`：页面恢复/导航，动态页面 key 注册；
  - `studyUi`：面板图标、共享组件/样式（按需）。
- 不要跨 bundle import 另一个插件的模块（包括组件、单例、字典）。共享 React 组件要么来自 core 服务，要么来自 `packages/` 普通库并在各自 bundle 内联。
- 页面定义仍用 `{ key, order, label, Page }`；`key` 与文件名一致；`label` 必须在本插件字典中存在；`order` 用 CONTRACTS 里的全局值。
- 删除页面时同步删除本插件的 messages、actions、测试与侧栏注册；不要留“半页”。

## 测试与命令

```powershell
# 现有工程级测试（无需应用）
node --test tests/project/config.test.mjs tests/project/credentials.test.mjs tests/project/import-errors.test.mjs

# 现有插件测试；拆分后改为对应目录
node --test plugins/study/tests
node --test plugins/study-core/tests plugins/study/tests

# 构建某个插件的客户端 bundle（P1 起）
node plugins/<plugin>/scripts/build-client.mjs

# 桌面冒烟：先启动应用，等日志出现 "dsh web: http" 后再执行
node tests/project/desktop.test.mjs
```

- 沙箱下 `node --test` 可能因 `spawn EPERM` 失败：对同一命令申请一次宿主权限，或按文件分别运行。
- 不请求真实模型；不新增付费调用。
- 没有命令输出时，不要写“已验证”。

## 完成标准（DoD）

1. 代码只在任务卡“所有权”列出的路径内。
2. 相关测试通过；应用能启动；页面、路由、工具、数据语义没有变化（除非任务卡明确说变）。
3. CONTRACTS 对应行已更新；STATUS 已填命令、结果、限制。
4. 没有新增未登记依赖，没有把探针/mock 留在发布路径。
5. 失败路径有明确提示，不静默成功。
6. 任务卡末尾写了“下一阶段注意事项”。

## 不要做

- 不改 DSH 核心、锁文件、根配置、`patches/`。
- 不拆数据库、不新增第二个 kernel、不复制 `changed_log/request_log` 逻辑。
- 不跨插件 import 业务实现；不共用客户端 locale NS。
- 不提前做后面阶段的内容；不顺手重构无关代码。
- 不 `git commit`、不 `git reset`、不清理 `source/deepseek-harness`。
- 不把“测试在沙箱里跑不了”当作通过。
- 不在没有用户确认时改变产品文案、页面顺序或默认行为（P5 的 order 冲突修复除外）。

## 阻塞与升级

- 前置阶段未 DONE、契约冲突、需要改 DSH 源码、需要新增依赖、需要改数据库结构且无法向后兼容：停下来，在 STATUS 写 BLOCKED，说明具体条件和建议。
- 不要用“临时绕过”继续；宁可停在一个可启动的状态。

## 交付记录模板

追加到 [STATUS.md](STATUS.md) 的“交付记录”：

```md
### Pn 插件名 — 会话记录
- 日期：
- 完成项：
- 未完成/偏差：
- 测试命令与结果：
- 新增/修改文件：
- 已知限制：
- 下一阶段注意事项：
```
