# T01：study 内核与服务骨架

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：1 个会话
- 依赖：T00
- 波次：W1
- 状态：见 [STATUS](../STATUS.md) 的 T01 行

## 目标

一个能被 DSH 加载的 study 插件包，提供存储、命名空间服务、通用路由、幂等与版本、变更日志与日快照。

## 所有权（只能改这些路径）

- `plugins/study/{package.json,host/index.mjs,host/db.mjs,host/kernel.mjs,host/registry.mjs}`
- `plugins/study/host/modules/kernel.mjs`
- `plugins/study/tests/kernel/**`
- `scripts/project-config.mjs`（只追加插件注册行）

## 交付

- `node:sqlite`（`DatabaseSync`，WAL）数据库与按模块的 schema 机制；数据根 `<root>/study/study.db`。
- `ctx.study.register(ns, impl)` / `ctx.study.call(ns, method, payload)`；`POST /api/study/<ns>/<method>`；统一错误码。
- `request_log` 幂等、`change_log`、`day_snapshot`、`tx()` 事务助手。
- 模块自动发现与 `deps` 拓扑排序；模块自带 schema，版本不兼容时拒绝启动并提示备份。
- 示例模块：`kernel.status` 方法 + `study_status` 工具。
- 单元测试：重复 `requestId`、并发同版本、重启恢复、未知 schema 拒绝写。

## 验收

- 无 UI 时能用工具读写并回读。
- 同 `requestId` 只生效一次；不同载荷同 ID 报 `conflict`。
- `expectedRevision` 过期被拒，返回最新 revision。
- 未知 schema 拒绝写入并给出恢复指引。
- `node --test plugins/study/tests` 通过。

## 不做

- 任何业务模块（tasks/materials/plans/timer/followup/outcomes/memory）。
- 页面、布局、构建脚本（T02）。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 T00 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T01 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。
