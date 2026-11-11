# 修复组 2：每日闭环

> 新会话先读本说明，再只读并执行其中一张任务卡。不要一次修多张卡。

## 这一组解决什么

让“确认计划 → 今日执行 → 提醒 → 晚间调整 → 第二天继续”真正跑通。数据基础（修复组 1）完成前，不要开始这一组。

## 任务卡与顺序

1. [SB-02 Agent 任务工具与计划页/工作台动作](tasks/02-agent-task-and-plan-actions.md) —— 依赖 SB-01。
2. [SB-06 提醒按执行块结束时间触发](tasks/06-reminder-timing-identity.md) —— 可用稳定块 ID，建议与 SB-04 串行。
3. [SB-04 剩余量、复盘拆分、暂定块和未安排再调度](tasks/04-remaining-work-and-review-split.md) —— 依赖 SB-01。
4. [SB-07 Schedule、复盘保存决策和学习通知](tasks/07-schedule-auto-review-notify.md) —— 依赖 SB-04、SB-06。

建议顺序：**SB-02 → SB-06 → SB-04 → SB-07**。

## 完成这一组的标志

- 计划页能确认/修订/记录进度；工作台出现计划物化出的任务。
- 工作台任务行能“问这道题”“开始番茄”；拖拽后 Agent 能看到新时间。
- 提醒在时间块预计结束后才出现，按执行块分别答复，不把未来块算逾期。
- 晚间复盘能处理真实剩余量、拆分/暂定/未安排；保存行为与 T12 决策一致。
- Schedule 或明确记录的降级方案可用；学习提醒有应用内 + 简单系统通知（权限允许时）。

## 不要做

- 不做 Creator 沙箱、自动记忆提取、安装器/自动更新。
- 不做跨日补发历史提醒；不承诺应用关闭后仍提醒。
- 不要在 SB-02 里另造第二套计划/进度字段。

## 完成情况（2026-11-11）

SB-02、SB-06、SB-04、SB-07 均为 DONE，完成记录见各任务卡第 8 节；`issues/tasks/README.md` 与 `STATUS.md` 已同步。关键证据：

- `node --test --test-isolation=none plugins/study/tests/plans plugins/study/tests/tasks plugins/study/tests/tutoring plugins/study/tests/client`（构建新鲜度需宿主权限，其余通过）。
- `node --test --test-isolation=none plugins/study/tests/followup` 38/38；`... plugins/study/tests/notify` 51/51。
- 真实浏览器通知证据：`plugins/study/tests/notify/learning-browser-smoke.mjs` → `plugins/study/tests/notify/evidence/learning-browser.json`，`passed: true`。
- 客户端构建：`node plugins/study/scripts/build-client.mjs` ok；最终产物以最后一次源码稳定后的构建为准。