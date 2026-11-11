# 修复组 1：数据基础

> 新会话先读本说明，再只读并执行其中一张任务卡。不要一次修多张卡。

## 这一组解决什么

把“计划条目、任务、时间块、进度、目标”收敛成一套可核对的业务事实，并保证写入幂等。它是后面三组的前提。

## 任务卡与顺序

1. [SB-01 统一任务、时间块、计划条目和进度](tasks/01-unified-task-facts.md) —— **必须第一个做**。
2. [SB-05 当前备考目标作用域](tasks/05-goal-scope.md) —— 依赖 SB-01。
3. [SB-03 草案独立版本与并发保护](tasks/03-draft-concurrency.md) —— 可与 SB-05 串行，避免同时改 `plans.mjs`。
4. [SB-08 所有写入强制幂等身份](tasks/08-idempotency.md) —— 依赖 SB-01，最后统一收口。

建议顺序：**SB-01 → SB-05 → SB-03 → SB-08**。

## 完成这一组的标志

- 确认一份计划后，工作台/左栏出现对应任务和时间块。
- 拖拽时间块后，计划页和 Agent 读到同一个新时间。
- 计划条目/任务 ID 不随改期、改材料、换展示方式变化。
- 当前目标切换后，任务/计划/成果不再串目标。
- 双击、网络重试、Agent 重试不会重复创建任务/目标/记忆/导入。

## 不要做

- 不新增页面或大功能；不顺手做 Creator、记忆提取、安装器。
- 不在 SB-01 完成前并行改 `plans.mjs`、`tasks.mjs`、`outcomes.mjs` 的 schema。
- 不修改 `ACCEPTED-SCOPE.md` 中明确不做的事项。

## 完成状态（2026-11-11）

四张卡均已完成（DONE），完成记录与验证结果见 [tasks/README.md](tasks/README.md) 及各自卡末：

- SB-01、SB-05、SB-03、SB-08 已按建议顺序串行完成。
- `node --test --test-isolation=none plugins/study/tests`：553 例，552 pass / 0 fail / 1 skip。
- `node plugins/study/tests/kernel/loader-smoke.mjs`：`passed: true`。
- 旧库迁移、草案并发、目标隔离和写入幂等均有回归测试覆盖。

