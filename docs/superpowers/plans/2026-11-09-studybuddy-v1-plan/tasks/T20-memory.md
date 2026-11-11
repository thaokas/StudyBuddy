# T20：记忆：现成插件验证与接入

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：1 个会话
- 依赖：T01
- 波次：W2
- 状态：见 [STATUS](../STATUS.md) 的 T20 行

## 目标

跨会话记住偏好与短期状态，可查看、纠正、删除；优先零代码。

## 所有权（只能改这些路径）

- `plugins/study/host/modules/memory.mjs`
- `plugins/study/client/pages/memory.js`
- `scripts/project-config.mjs`（如需注册插件）
- `docs/decisions/memory.md`

## 交付

- 前 2–3 小时：隔离 profile 安装 `@restregular/dsh-memory`，验证加载、跨会话召回、重启持久化、修订、删除、中文词法召回；写结论与版本组合。
- 可零代码满足 → 只做配置 + 设置页入口。
- 不满足 → 本地实现：`memory.json`（偏好/短期状态/待确认观察，带时间与来源）+ `remember/recall/forget` 工具 + 每次对话注入小上下文。
- 删除抑制：删除标记优先于旧对话重建。

## 验收

- 新会话能召回明确偏好。
- 短期状态到期失效。
- 删除后不再召回且不被重建。
- 记忆不含计划/完成量副本。
- 两种路线的选择有证据。

## 不做

- 向量检索、图数据库、自动批量提取（v1.1）。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 T01 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T20 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。
