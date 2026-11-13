# P5：抽出 study-reminders

- 前置：P3（G3 通过）；P4 不是硬前置，但按计划顺序执行
- 预计：0.5–1 个会话
- 质量门：G5（见 [PLAN.md](../PLAN.md) §7）
- 结果：业务行从 5 变 6：core + facts + learning + reminders + memory + shell；shell 只剩 outcomes

## 目标

把提醒与完成提示迁到 `plugins/study-reminders`：

- host：`followup` 模块（时段提醒、晚间复盘、后台心跳）；
- client：`reminders` 页面、`messages/reminders.js`、`notify.js`（回复完成提醒与 General 设置行）、`messages/notify.js`、`learning-notify.js`（提醒页的浏览器通知 helper）；
- 修复客户端侧栏 order 冲突：`reminders` 从 16 改为 **17**（`plan` 保持 16）。

## 开工前读

1. [AGENT.md](../AGENT.md)、[CONTRACTS.md](../CONTRACTS.md) 第 2/3/4/7 节
2. [ADR](../../../decisions/plugin-split.md) 第 5.2、6.1–6.4 节
3. `plugins/study/host/modules/followup.mjs`
4. `plugins/study/client/pages/reminders.js`、`client/messages/reminders.js`、`client/notify.js`、`client/messages/notify.js`、`client/learning-notify.js`
5. `plugins/study/tests/{followup,notify}/`
6. P3/P4 的交付记录

## 所有权

**新建/可改：**

- `plugins/study-reminders/**`
- `plugins/study/host/index.mjs`（移除 followup 模块注册）
- `plugins/study/client/plugin.js`（移除 reminders 页面、notify 安装）
- `client/pages/reminders.js`、`client/messages/reminders.js`、`client/notify.js`、`client/messages/notify.js`、`client/learning-notify.js`（迁出后删除）
- `plugins/study/tests/{followup,notify}/`（迁出后删除）
- `scripts/project-config.mjs`（插入 reminders 行）
- `CONTRACTS.md`、`STATUS.md`

**不可改：**

- followup/notify 的业务规则、文案、工具/设置 schema；
- 其他插件；
- `source/deepseek-harness/`、`patches/`、`platform/`。

## 步骤

1. **基线。** 跑 followup/notify 测试；记录 reminders 页面、followup 命名空间/工具、settings general 行、banner、heartbeat；备份 `plugins/study` 到 `.studybuddy/plugin-split-backup/P5/`。
2. **建包。** `plugins/study-reminders/package.json`，名称 `@studybuddy/study-reminders`，`exports["./client"]`，`dsh.client.inject = ["@studybuddy/study-core"]`。
3. **迁 host。**
   - 移动 `followup.mjs`；入口 `inject = ['study', 'tools']`；按模板注册 schema/命名空间/工具。
   - 心跳/后台检查保留；依赖 tasks/plans 命名空间，失败时按现有 `unavailable` 语义降级。
   - 读取 `study_task.goal_id` / `study_plan.goal_id` 的 SQL 保留，登记到 CONTRACTS 的读契约（facts → reminders，v1）。
4. **迁 client。**
   - 移动 `reminders` 页面与 messages；`key: 'reminders'`，`order` 改为 **17**；locale NS 用 `study-reminders`。
   - 移动 `notify.js`、`messages/notify.js` 与 `learning-notify.js`（提醒页的浏览器通知 helper）；banner 的 `shell.overlay` 注册与 General 设置行 `settings.general.item` 保留；storage key 不变（`study.notify.completion.*`）。
   - 页面/横幅使用 core 的 `studyClient`；定时器状态读取 timer 命名空间（facts）。
5. **从 shell 移除。**
   - 删除 followup 模块与注册、reminders 页面/messages、notify 安装与 messages、`learning-notify.js`；
   - shell 只剩 outcomes；
   - 更新 barrel/字典，确保无悬空 import。
6. **profile。**
   - 插入 `study-reminders` 行；推荐顺序：`study-core` → `study-facts` → `study-learning` → `study-reminders` → `study-memory` → `study`。
   - 记录实际顺序到 CONTRACTS。
7. **测试。**
   - 测试迁到 `plugins/study-reminders/tests`，只改 import；
   - 增加：页面 order 唯一（reminders 17、plan 16）；禁用 reminders 时 banner/设置行消失、其他功能正常；timer 命名空间缺失时提醒页明确不可用；
   - 跑 reminders + facts + learning + memory + shell + 工程测试。
8. **冒烟。**
   - 启动：提醒页可达、order 在 plan 之后；完成一次回复触发 banner/通知；设置里的开关仍可读写；
   - 禁用 reminders 行（测试 profile）→ 应用启动，提醒页与 banner 消失，计划/工作台正常。

## 验收（G5）

- [ ] `study-reminders` 独立行/独立 bundle/独立 NS；
- [ ] reminders 页面、banner、设置行、heartbeat 行为与基线一致；
- [ ] `reminders` order = 17，`plan` = 16，无重复；
- [ ] shell 只剩 outcomes；
- [ ] 禁用 reminders 时其他功能正常；
- [ ] 测试迁出后全量通过；
- [ ] CONTRACTS 的命名空间/表/读契约/页面行已更新；
- [ ] 无跨插件业务 import、无跨插件写。

## 明确不做

- 不改提醒文案、时段策略、通知去重逻辑；
- 不迁移 outcomes；
- 不把通知改成系统级新能力；
- 不删除旧 shell。

## 回退

- 停止应用；恢复备份的 `plugins/study`；删除 `plugins/study-reminders`；profile 行改回；重启验证。
- 若只是 reminders 行有问题，先禁用该行回到 P4 状态。

## 交付记录

在 STATUS 追加 P5 记录；在本文件末尾写：

```md
## 下一阶段注意事项
- 行顺序与 order 实际表现：
- notify/banner/设置行的注册点：
- shell 剩余内容：
- outcomes 迁移时可复用的模式：
```
