# P6：抽出 study-outcomes，删除旧 shell

- 前置：P4、P5（G4/G5 通过）
- 预计：0.5–1 个会话
- 质量门：G6（见 [PLAN.md](../PLAN.md) §7）
- 结果：业务行定型为 6：core + facts + learning + memory + reminders + outcomes；`plugins/study` 旧 shell 删除

## 目标

1. 把 `outcomes`、`milestones` 与成果页、里程碑反馈迁到 `plugins/study-outcomes`。
2. 删除旧 `plugins/study` 包与 profile 行，改由 6 个插件分别注册所有页面/模块。
3. 验证所有页面、路由、工具、导出、禁用矩阵都成立。

## 开工前读

1. [AGENT.md](../AGENT.md)、[CONTRACTS.md](../CONTRACTS.md) 全文
2. [ADR](../../../decisions/plugin-split.md) 第 5.3、5.4、6.1–6.5 节
3. `plugins/study/host/modules/{outcomes,milestones}.mjs`
4. `plugins/study/client/pages/outcomes.js`、`client/messages/outcomes.js`、`client/components/feedback.js`、`client/messages/feedback.js`
5. `plugins/study/tests/{outcomes,milestones}/`
6. P4/P5 的交付记录

## 所有权

**新建/可改：**

- `plugins/study-outcomes/**`
- `plugins/study/client/**`（最后移除残留）
- `plugins/study/**`（整个目录在验收后删除）
- `skills/study-creator/**`（从 `plugins/study/creator/skills/study-creator` 迁入）
- `tests/creator/**`（从 `plugins/study/creator/{tests,evidence}` 迁入）
- `scripts/project-config.mjs`（删除旧 `study` 行；更新 `creatorSkillSource`）
- `scripts/backup-studybuddy.mjs`（确认 P1 的 export 路径仍有效；如 shell 内还有引用则更新）
- `README.md`、`docs/creator.md`、`docs/backup.md`（当前路径/命令更新）
- `docs/plans/2026-11-11-plugin-split/README.md`、`AGENT.md`（仓库地图更新）
- `CONTRACTS.md`、`STATUS.md`

**不可改：**

- 其他插件的业务逻辑/文案；
- 数据库 schema；
- `source/deepseek-harness/`、`patches/`、`platform/`。

## 步骤

1. **基线。** 跑 outcomes/milestones 测试；记录成果页、里程碑反馈、两个命名空间、导出；备份 `plugins/study` 到 `.studybuddy/plugin-split-backup/P6/`。
2. **建包。** `plugins/study-outcomes/package.json`，名称 `@studybuddy/study-outcomes`，`exports["./client"]`，`dsh.client.inject = ["@studybuddy/study-core"]`。
3. **迁 host。**
   - 移动 `outcomes.mjs`、`milestones.mjs`；入口 `inject = ['study', 'tools']`；注册两个命名空间（无表，schema 为空）。
   - `outcomes` 的当天快照 provider 保留；确认 P1 的快照顺序问题已解决。
   - 读取 facts 表的只读 SQL 保留，登记到 CONTRACTS（facts → outcomes，v1）。
   - `review` 只通过 `ctx.study.call('review', ...)` 或客户端调用；不要在 host 中 import learning 实现。
4. **迁 client。**
   - 移动 outcomes 页面、messages、feedback 组件与 messages；`key: 'outcomes'`、`order: 25` 不变。
   - locale NS 用 `study-outcomes`；共享文案从 `packages/study-messages` 合并。
   - 成果页的报告区对 `review` 是软依赖：`learning` 被禁用或方法不存在时显示“报告不可用”，页面其他统计仍工作。
   - 里程碑反馈 toast 保留；使用 core 的 `studyClient`/`studyRefresh`。
5. **迁移 Creator skill 与验证脚本（删除 shell 之前）。**
   - 把 `plugins/study/creator/skills/study-creator` 整体迁到 `skills/study-creator`；
   - 把 `plugins/study/creator/tests`、`plugins/study/creator/evidence` 迁到 `tests/creator`；
   - 更新 `scripts/project-config.mjs` 的 `creatorSkillSource` 指向新路径；
   - 更新 `docs/creator.md` 中的路径、测试命令、证据位置；
   - 更新 `tests/creator/*.mjs` 的相对 import（例如 `profile-compose.mjs` 到 `scripts/project-config.mjs`）；
   - 跑 `node --test --test-isolation=none tests/creator` 与 `node tests/creator/profile-compose.mjs`（需要真实 Host 的 smoke 按原文档条件执行）。
6. **删除旧 shell。**
   - 删除 `plugins/study` 目录（确认没有其他文件仍被引用；Creator 资产已迁出）；
   - `deploymentPolicy` 删除 `study` 行；
   - 检查 `scripts/`、`tests/project/`、`README.md`、`docs/` 中是否还有 `plugins/study` 路径引用，更新为对应插件/新路径；`docs/plans/2026-11-08*`、`2026-11-09*` 等历史计划**保留**旧路径作为历史记录，不要改。
   - 检查 `scripts/backup-studybuddy.mjs` 的 export import 已指向 core；跑 `node scripts/backup-studybuddy.mjs --drill`。
7. **profile 行顺序（最终）。**
   - `study-core` → `study-facts` → `study-learning` → `study-reminders` → `study-memory` → `study-outcomes`；
   - `project-credentials` 保持；
   - `a02-probe` 仍在，P7 删除。
8. **测试。**
   - 测试迁到 `plugins/study-outcomes/tests`，只改 import；
   - 增加/保留：
     - 6 个插件的 9 个页面 key/order/NS 全部唯一；
     - 每个插件的命名空间只在启用时存在；
     - 禁用 outcomes 时其他页面正常；
     - 禁用 learning 时成果页报告区降级；
     - 导出包含所有表（含被禁用插件的表）；
   - 跑所有插件测试 + 工程测试。
9. **冒烟。**
   - 启动：9 个页面可达，侧栏顺序与 CONTRACTS 一致；
   - 成果页日/周/月统计、里程碑反馈正常；
   - 关闭任一可选插件，重启，页面/工具消失但不崩；重新启用后数据仍在；
   - `kernel.status` 报出 6 个插件的模块。

## 验收（G6）

- [ ] 6 个业务插件行全部可启动；旧 shell 不存在；
- [ ] 9 个页面 key/order/NS 唯一，`study.layout.page` 能恢复旧 key；
- [ ] 所有命名空间/工具/路由与拆分前等价；
- [ ] 导出、备份覆盖所有表；禁用插件的数据仍保留；`node scripts/backup-studybuddy.mjs --drill` 通过；
- [ ] 禁用矩阵通过：core/facts 不可关闭；learning/memory/outcomes/reminders 可关闭并降级；
- [ ] Creator skill 已迁到 `skills/study-creator`，`creatorSkillSource` 指向新路径；`tests/creator` 的单元/组合测试通过；
- [ ] 全量测试通过；
- [ ] CONTRACTS 更新为最终版；README/AGENT 仓库地图更新。

## 明确不做

- 不新增统计口径、文案、里程碑规则；
- 不拆 facts、不改 schema；
- 不做 bundle/启动器（P7）；
- 不清理 `a02-probe`（P7）。

## 回退

- 停止应用；恢复备份的 `plugins/study` 与 profile 的 `study` 行；删除 `plugins/study-outcomes`；重启验证。
- P6 之后没有 shell 可回退到更早状态，只能回到 P5 备份；因此本阶段开工前必须确认 P4/P5 稳定。

## 交付记录

在 STATUS 追加 P6 记录；在本文件末尾写：

```md
## 下一阶段注意事项
- 6 个插件行顺序与 profile 实际内容：
- 旧 shell 是否完全删除、遗留引用：
- 禁用矩阵结果：
- P7 bundle 需要带上的行/配置：
```
