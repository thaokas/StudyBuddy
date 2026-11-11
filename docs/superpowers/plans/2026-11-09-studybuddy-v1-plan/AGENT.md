# AGENT：每个开发会话先读这一份

任务卡在 [`tasks/`](tasks/)，状态在 [`STATUS.md`](STATUS.md)，总体计划在 [`PLAN.md`](PLAN.md)。本文件只写"所有任务都通用"的约定。

## 一分钟开工

1. 读本文件和你自己的任务卡。
2. 在 STATUS 里确认任务卡列的依赖都已 DONE；不满足就停，并在 STATUS 写 BLOCKED。
3. 只改任务卡"所有权"列出的路径。
4. 先写测试或证据脚本，再改实现；结束把 STATUS 对应行改成 DONE/REVIEW/BLOCKED。

## 仓库地图

```text
plugins/study/              唯一业务插件（host + client + tests，T01/T02 建立）
scripts/                    启动器 start-studybuddy.mjs、部署策略 project-config.mjs、备份脚本
platform/windows-credentials/  DPAPI 凭据提供器（v0 已有，不要重写）
patches/                    对 DSH 源码的唯一改动，带重放说明
tests/project/              工程级测试（README 说明两层命令）
source/deepseek-harness/    固定 DSH 源码；不要改，除非任务卡明确授权布局补丁
.studybuddy/                本地运行数据（被 .gitignore 忽略）
```

外层工作区**没有 Git**：任务隔离靠目录所有权，不靠分支。`source/deepseek-harness` 自身在 `task/studybuddy-model-config` 分支且改动未提交；不要提交、重置或清理它。

## 加文件即注册（不要手改公共注册表）

| 位置 | 约定 |
| --- | --- |
| `plugins/study/host/modules/*.mjs` | 导出 `{ id, deps = [], schema = [], apply(ctx, kernel) }`；入口自动发现并按 `deps` 拓扑排序 |
| `plugins/study/client/pages/*.js` | 默认导出 `{ key, order, label, Page }`；构建脚本自动生成 barrel |
| `plugins/study/client/actions/*.js` | 默认导出 `{ id, page?, run }`；页面通过动作注册表渲染 |

公共文件 `host/index.mjs`、`scripts/build-client.mjs` 只由 T01/T02 建立。后续任务需要注册项时，只允许单行追加，且必须串行（同一时间只有一个会话改它）。

## 服务契约（T01 冻结，后续只增不改）

- `ctx.study.register(ns, impl)` / `ctx.study.call(ns, method, payload)`；`ns ∈ {kernel, tasks, materials, plans, timer, followup, outcomes, memory}`。
- `POST /api/study/<ns>/<method>`，请求体 `{ requestId, expectedRevision?, ... }`。
- 成功 `{ ok: true, value, revision }`；失败 `{ ok: false, code, message, details }`，`code ∈ {invalid, conflict, not_found, unavailable}`。
- `requestId` 幂等：同 ID 返回首次结果，不同载荷同 ID 报 `conflict`。
- `change_log` 只追加；`day_snapshot` 每天首次打开写一次。
- 前端与生成插件只经服务读写，**不得直接打开数据库文件**。

## 不可违反的不变量

1. 界面与 Agent 只经 `ctx.study` 写。
2. 同 `requestId` 只生效一次。
3. 过期草案不得覆盖新修订或手动修改。
4. "待确认"不等于"未完成"；未勾选不推断未学习。
5. 计时不等于完成；中断需学生确认；离线时间不计入。
6. 取消不计入完成率；不伪造"全部完成"。
7. 后台失败不得宣布成功。
8. 凭据不进聊天、日志、导出包。
9. 无 Key/断网时本地功能完整可用。
10. 未提供的能力隐藏入口并写明，不放假按钮。

## 测试

```powershell
# 工程单元测试（无需应用）
node --test tests/project/config.test.mjs tests/project/credentials.test.mjs tests/project/import-errors.test.mjs

# 插件测试（T01 起）
node --test plugins/study/tests

# 桌面冒烟：先启动应用，等日志出现 "dsh web: http" 后再执行
node tests/project/desktop.test.mjs
```

沙箱下 `node --test` 可能因 `spawn EPERM` 失败：对同一命令申请一次宿主权限，或按文件分别运行。细节见 [`tests/project/README.md`](../../../../tests/project/README.md)。

## 完成标准

1. 代码只在所有权目录内；越界改动视为未完成。
2. 有可复跑的测试或证据脚本，结果写进 STATUS。
3. STATUS 填了命令、结果、已知限制。
4. 没引入未登记依赖，没把 mock 留在发布路径。
5. 失败路径有明确提示，不静默成功。

## 不要做

- 不改 DSH 核心（布局补丁需任务卡授权），不改锁文件与根配置。
- 不代做其他任务，不顺手重构无关代码。
- 不在没有命令输出时宣布"已验证"。
- 不把生成插件或探针混入发布产物。

## 启动提示词（给排任务的人）

最简单一句就够：

```text
阅读 docs/superpowers/plans/2026-11-09-studybuddy-v1-plan/tasks/T01-kernel.md 并执行。
```

任务卡会要求会话先读本文件；如果想更保险：

```text
阅读 docs/superpowers/plans/2026-11-09-studybuddy-v1-plan/AGENT.md 和 tasks/T01-kernel.md，执行 T01。
```
