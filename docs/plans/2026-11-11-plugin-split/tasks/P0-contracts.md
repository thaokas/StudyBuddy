# P0：冻结插件契约（只写文档）

- 前置：无
- 预计：0.5 个会话
- 产出：[CONTRACTS.md](../CONTRACTS.md) 完整版；[README.md](../README.md)、[PLAN.md](../PLAN.md) 如有偏差一并修正
- 质量门：G0（见 [PLAN.md](../PLAN.md) §7）

## 目标

把拆分需要的名字、边界、版本一次性定死，让 P1–P7 不再临场发明。**本阶段不写代码、不改 profile、不改数据库。**

## 开工前读

1. [AGENT.md](../AGENT.md)
2. [PLAN.md](../PLAN.md)
3. [CONTRACTS.md](../CONTRACTS.md)（待填模板）
4. [ADR](../../../decisions/plugin-split.md) 第 3、5、6 节
5. 现有代码：
   - `plugins/study/host/index.mjs`、`host/db.mjs`、`host/kernel.mjs`、`host/registry.mjs`、`host/facts.mjs`
   - `plugins/study/host/modules/*.mjs`（只看导出与 schema，不必通读实现）
   - `plugins/study/client/plugin.js`、`client/lib/*.js`、`client/pages/*.js`、`client/messages/*.js`
   - `scripts/project-config.mjs` 的 `deploymentPolicy`
   - `.studybuddy/home/cordis.patch.yml`（当前实际 profile 行）

## 所有权

**可改：**

- `docs/plans/2026-11-11-plugin-split/CONTRACTS.md`
- `docs/plans/2026-11-11-plugin-split/README.md`
- `docs/plans/2026-11-11-plugin-split/PLAN.md`
- `docs/plans/2026-11-11-plugin-split/STATUS.md`

**不可改：**

- 任何 `plugins/`、`packages/`、`scripts/`、`platform/`、`tests/` 代码；
- `docs/decisions/plugin-split.md`（如发现 ADR 有误，先在 STATUS 写问题，等用户确认后再改）；
- `source/deepseek-harness/`。

## 步骤

1. **扫描 host 模块。** 对每个 `host/modules/*.mjs` 记录：
   - `id`、`deps`、`schemaVersion`、`schema` 里的表/索引/触发器/FTS；
   - `ctx.study.register` 的命名空间、方法名、`writes`；
   - `ctx.tools.register` 的工具名；
   - `ctx.on` 监听的事件、`ctx.emit` 发布的事件；
   - 跨模块直接 SQL 读的表。
2. **扫描客户端。** 对每个 `client/pages/*.js`、`messages/*.js`、`actions/*.js` 记录：
   - 页面 key、order、label、messages 依赖；
   - 页面调用的命名空间方法；
   - 共享字典键（`common.*`、`daily.*` 及其它跨页键）；
   - 模块级单例（`refresh.js`、`study-page.js`、action registry、panel icon）。
3. **填 CONTRACTS。** 按模板补齐第 1–9 节，特别是：
   - 插件 id/包名/目录/行 id；
   - 命名空间与写方法；
   - 表所有权（谁建表谁拥有）；
   - 跨插件只读契约（消费者、表/列、用途、版本）；
   - 事件；
   - 工具；
   - 页面 key/order/locale NS；
   - profile/bundle 行；
   - 兼容版本。
4. **定包布局与命名。** 确认 `packages/study-contracts`、`study-model`、`study-messages` 的职责；确认 `plugins/study-*` 目录；确认不引入根 workspace。
5. **定模块注册 API。** 在 CONTRACTS 里写清：
   - `ctx.study.module({ id, deps, schemaVersion, schema, readContracts })` 的字段与失败语义；
   - 版本不匹配只禁用该插件的规则；
   - `kernel.status` 如何报告已注册模块；
   - `ctx.study.has(ns)` / 可选依赖的能力探测方式。
6. **定客户端服务接口。** 写清 `studyClient`、`studyRefresh`、`studyNav`、`studyUi` 的最小方法集，以及功能插件如何 `inject` 它们。
7. **列出待用户确认项**，至少包括：
   - facts 作为一个插件（vs 两个同启同停的行）；
   - memory 作为第一个功能插件试点；
   - `reminders` 的 order 从 16 改为 17（修复与 `plan` 的冲突）；
   - 旧 shell 在 P1–P5 继续存在、P6 删除；
   - `project-credentials` 行 id 保持不变。

## 验收（G0）

- [ ] `CONTRACTS.md` 第 1–9 节无 `待核对`（明确延后项要在第 10 节列出并说明原因）；
- [ ] 每个现有模块/页面/工具/表都能在 CONTRACTS 找到归属；
- [ ] 包名、行 id、页面 key、order、locale NS 可直接被 P1 使用；
- [ ] 用户对第 7 步列出的确认项给出结论；
- [ ] 没有修改任何代码文件。

## 不要做

- 不写代码、不改 profile、不跑会改数据的命令；
- 不重命名现有命名空间、页面 key、工具名（这会破坏现有数据和 Creator 契约）；
- 不提前拆 facts、不决定发行打包细节；
- 不把 `CONTRACTS.md` 写成又一份 ADR；它只记事实与契约。

## 交付记录

在 [STATUS.md](../STATUS.md) 追加 P0 记录，并在本文件末尾写：

```md
## 下一阶段注意事项
- P1 可以直接使用的包名/行 id：
- 仍需在 P1 核实的契约：
- 已知风险：
```
