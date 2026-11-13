# 插件拆分状态表

- 日期：2026-11-11
- 当前阶段：**P0 未开始**
- 计划：[PLAN.md](PLAN.md) · 规则：[AGENT.md](AGENT.md) · 契约：[CONTRACTS.md](CONTRACTS.md)

## 1. 阶段状态

| 阶段 | 内容 | 状态 | 会话/日期 | 证据（命令、退出码、关键输出） |
| --- | --- | --- | --- | --- |
| P0 | 冻结契约（只写文档） | TODO | — | — |
| P1 | 抽 `study-core` + 共享库；旧 shell 变第二行 | TODO | — | — |
| P2 | memory 试点 | TODO | — | — |
| P3 | 抽 `study-facts` | TODO | — | — |
| P4 | 抽 `study-learning` | TODO | — | — |
| P5 | 抽 `study-reminders` | TODO | — | — |
| P6 | 抽 `study-outcomes`；删除旧 shell | TODO | — | — |
| P7 | `study-bundle` + 启动器清理 | TODO | — | — |

状态取值：`TODO` / `IN PROGRESS` / `REVIEW`（等用户审核）/ `DONE` / `BLOCKED`。

## 2. 当前基线（拆分前）

| 项 | 值 |
| --- | --- |
| 业务插件 | `plugins/study` 单包，host + client |
| profile 插件行 | `project-credentials`、`study`、`a02-probe`（绝对路径） |
| 模块 | 14 个 `host/modules/*.mjs`，13 个命名空间 |
| 客户端 | 9 个页面、1 个 `study` 字典、1 个 `client.js` |
| 数据库 | `<数据根>/study/study.db`，单 kernel |
| DSH | `0.2.2-rc.1`，基线 `fcc0ad4` |
| 测试 | `node --test plugins/study/tests` + `tests/project/*` |

## 3. 交付记录

> 每个会话结束追加一条；不要覆盖历史。格式见 AGENT.md。

（尚无记录）

## 4. 阻塞

| 日期 | 阶段 | 具体条件 | 建议 |
| --- | --- | --- | --- |
| — | — | — | — |

## 5. 变更日志

| 日期 | 变更 | 影响 |
| --- | --- | --- |
| 2026-11-11 | 建立计划目录与 P0–P7 任务卡 | 尚无代码改动 |
