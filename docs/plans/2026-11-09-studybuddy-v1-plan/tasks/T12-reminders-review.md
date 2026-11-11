# T12：应用内提醒与晚间复盘

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：1 个会话
- 依赖：T06、T09
- 波次：W5
- 状态：见 [STATUS](../STATUS.md) 的 T12 行

## 目标

到点问一句，晚上只动没做完的部分。

## 所有权（只能改这些路径）

- `plugins/study/host/modules/followup.mjs`
- `plugins/study/client/panels/reminders.js`
- `plugins/study/tests/followup/**`

## 交付

- Schedule 触发，去重键 = 任务 + 时段。
- 静默/专注延后；提醒卡片与快捷答复（完成/部分/未完成/稍后）。
- 晚间复盘：读进度 → 算剩余 → 用弹性 → 保存修订 → 摘要。
- 失败保留"待调整"，不宣布成功。

## 验收

- 同任务每时段只问一次。
- 多项逾期合并。
- 复盘不覆盖手动修改。
- 容量不足保留未安排并解释。
- 关闭应用不补发历史提醒。

## 不做

- OS 通知（T15 负责回复完成通知）。
- 跨日补发。
- 模型自主改目标。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 T06、T09 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T12 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。

## 2026-11-11 修复组 2 对齐

本卡的旧交付口径（Schedule 触发、去重键 = 任务 + 时段、复盘直接保存修订、不做 OS 通知）已被 SB-02/04/06/07 修复覆盖，后续以任务卡和代码为准：

- **提醒**：身份为 `block:<blockId>`，执行块预计结束后才触发；同一任务不同块分别答复；UI 只合并展示。Host 每 15 秒心跳 + Renderer 15 秒轮询，应用关闭不提醒。
- **复盘保存决策（选项 B）**：到点只预览/提示，学生点击「保存调整」才保存；文案明确“需要你确认”。这是明确的产品决策，不再宣称无人确认自动调整。
- **复盘内容**：保留原始估算；按最新累计完成量计算剩余；可拆分执行块、生成待确认暂定块、保留 `date:null` 未安排工作并在容量不足时解释；确认完成后清理暂定重复块。
- **Schedule**：当前 DSH Schedule 面向 Session 投递 prompt，不能调用确定性服务回调，记录为降级方案（`followup.recovery.scheduling.status = 'degraded'`），不把 Renderer 轮询写成 Schedule。
- **通知**：任务提醒在权限允许时用 `new Notification()` 发一次并复用 reminder key；番茄完成复用同一通道；权限拒绝只保留页内。真实 Edge 证据在 `plugins/study/tests/notify/evidence/learning-browser.json`。
- **恢复摘要**：`followup.recovery` 返回最近复盘、未答复提醒、待确认进度、调度降级与 `reviewDecision: 'manual_confirmation'`；banner 展示后可关闭，不逐条补发历史。

详细完成记录见 `issues/tasks/06-reminder-timing-identity.md`、`07-schedule-auto-review-notify.md`、`04-remaining-work-and-review-split.md`。
