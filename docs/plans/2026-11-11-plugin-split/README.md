# 插件拆分工作计划（P0–P7）

- 日期：2026-11-11
- 状态：**未开始**（本目录只是计划与操作说明，没有代码改动）
- 依据：[插件拆分与依赖模型（ADR）](../../decisions/plugin-split.md)
- 目标：把当前单一 `@studybuddy/study` 插件，按“分层 + 基础插件 + 单向依赖”拆成可独立开发、可分别启停的多个 DSH 插件，并最终用 `@studybuddy/bundle` 组合成定制化 DSH。

## 这个目录是什么

这里不是又一份分析，而是**交给新会话执行的操作说明**。每个阶段对应一份任务卡；新会话只读自己那份，不提前做后面的内容。所有阶段共享的规则在 [AGENT.md](AGENT.md)，契约清单在 [CONTRACTS.md](CONTRACTS.md)，状态在 [STATUS.md](STATUS.md)，总体计划在 [PLAN.md](PLAN.md)。

```text
README.md                 本文件：目录、顺序、开工方式
AGENT.md                  每个会话先读：通用规则、命令、禁止项
PLAN.md                   总体计划：目标架构、阶段表、质量门、风险
CONTRACTS.md              单一契约清单：插件/命名空间/表/事件/页面/order/版本
STATUS.md                 状态表与交付记录
tasks/
  P0-contracts.md         冻结契约（只写文档）
  P1-core.md              抽 study-core + 共享库，旧 shell 变第二行
  P2-memory.md            memory 试点，成为第二个功能插件
  P3-facts.md             抽 study-facts 业务基础
  P4-learning.md          抽 study-learning
  P5-reminders.md         抽 study-reminders
  P6-outcomes.md          抽 study-outcomes，删除旧 shell
  P7-bundle.md            建 study-bundle，清理启动器与探针
```

## 阶段顺序

```text
P0 契约冻结
 └─ P1 core + 共享库（旧 shell 仍在）
     └─ P2 memory 试点
         └─ P3 facts 业务基础
             ├─ P4 learning
             ├─ P5 reminders
             └─ P6 outcomes（删除旧 shell）
                 └─ P7 bundle + 启动器清理
```

- P2 只依赖 P1，不依赖 P3；它是“多插件”模式的试点。
- P3 依赖 P1/P2；P4/P5/P6 依赖 P3；P6 必须在 P4/P5 之后。
- P7 依赖 P0–P6 全部完成。

## 每个会话怎么开工

把下面一段（替换阶段号）贴给新会话，或让它自己读：

```text
阅读 docs/plans/2026-11-11-plugin-split/AGENT.md 和 docs/plans/2026-11-11-plugin-split/tasks/P2-memory.md，执行 P2。
开工前先读 README.md、PLAN.md、CONTRACTS.md、STATUS.md 和 docs/decisions/plugin-split.md 的相关章节。
```

会话结束前必须：

1. 跑任务卡列出的测试/冒烟命令，把结果写进 [STATUS.md](STATUS.md)；
2. 更新 [CONTRACTS.md](CONTRACTS.md) 中本阶段改动的行；
3. 在 [STATUS.md](STATUS.md) 的交付记录里追加一条；
4. 在任务卡末尾写“下一阶段注意事项”。

## 全局约束（摘要，完整见 AGENT.md）

- **不改产品行为与文案**；这是纯结构重构，页面、路由、工具、数据语义保持不变。
- **不改 `source/deepseek-harness`**；DSH 是固定依赖，本计划不新增核心补丁。
- **不引入新的 npm 依赖**；继续用 Node 内置模块和固定源码树里的 esbuild。
- **单库单 kernel**；不按插件拆数据库，不绕过 `ctx.study` 直连数据库文件。
- **不跨插件 import 业务实现**；共享代码只进 `packages/` 下的共享库。
- **基础插件不可关闭**：`study-core`、`study-facts`；功能插件可关闭并降级。
- **不 `git commit`**；改动留在工作区，由用户审核。
- **每个阶段结束时应用必须可启动、现有测试必须绿**；不允许“中间状态先放着”。

## 不做的事（本计划范围外）

- 新功能、新页面、新模型调用；
- 发行打包、品牌、安装器、更新源；
- 把 facts 再拆成 tasks/plans 两个独立插件（见 ADR 第 8 节前置条件）；
- 把 `study-core` 做成沙箱或独立进程；
- 删除 `patches/` 中的桌面补丁或改变 DSH 版本。

## 相关文件

- ADR：[docs/decisions/plugin-split.md](../../decisions/plugin-split.md)
- 旧计划的通用规则：[docs/plans/2026-11-09-studybuddy-v1-plan/AGENT.md](../2026-11-09-studybuddy-v1-plan/AGENT.md)
- 记忆增量计划的“一阶段一会话”写法：[docs/plans/2026-11-11-memory-increments/README.md](../2026-11-11-memory-increments/README.md)
