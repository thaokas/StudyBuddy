# docs 索引

本目录放 StudyBuddy 的产品设计、开发计划、决策记录与操作手册。**代码不在这里**，代码在 `plugins/`、`scripts/`、`tests/` 与固定的 `source/deepseek-harness`。

## 1. 该读哪一份

| 想知道什么 | 读这里 |
| --- | --- |
| 产品要做成什么样 | [`specs/`](specs/) 的两份设计文档 |
| 现在做到哪一步、哪些任务没完成 | [`plans/2026-11-09-studybuddy-v1-plan/STATUS.md`](plans/2026-11-09-studybuddy-v1-plan/STATUS.md) |
| 计划怎么排、任务归谁、哪些不做 | [`plans/2026-11-09-studybuddy-v1-plan/PLAN.md`](plans/2026-11-09-studybuddy-v1-plan/PLAN.md) |
| 某块接口/表/行为的冻结约定与已知限制 | [`plans/2026-11-09-studybuddy-v1-plan/BOUNDARIES.md`](plans/2026-11-09-studybuddy-v1-plan/BOUNDARIES.md) |
| 某个技术选择为什么这样做 | [`decisions/`](decisions/) |
| 怎么启动、怎么排障 | [`manual/manual-start.md`](manual/manual-start.md) |
| 备份/恢复、创造模式怎么用 | [`backup.md`](backup.md)、[`creator.md`](creator.md) |
| 记忆系统四轮怎么做的、验收结论 | [`plans/2026-11-11-memory-increments/DELIVERY.md`](plans/2026-11-11-memory-increments/DELIVERY.md) |

## 2. 目录

### `specs/` — 产品语义（最高权威）

| 文件 | 内容 |
| --- | --- |
| `2026-11-08-studybuddy-redesign-design.md` | 整体重新设计：DSH 作为宿主、插件边界、目标/任务/计划/答疑/成果/记忆的数据语义、14 个验收场景 |
| `2026-11-11-student-memory-design.md` | 学生记忆系统：问答单元、00:00 学习日窗口、七类画像、分析与周报 |

文档冲突时，**以 spec 的产品语义为准**；实现方式以 `plans/` 与 `decisions/` 为准。

### `plans/` — 开发计划与实际状态

| 路径 | 内容 | 状态 |
| --- | --- | --- |
| `2026-11-09-studybuddy-v1-plan/` | **现行计划**，T00–T20 共 20 个会话任务 | T00–T17、T20 完成；**T18 发布候选包、T19 全场景验收未开始** |
| `2026-11-11-memory-system-plan.md` | 记忆系统总纲（S1–S4 的拆分依据） | 已由四轮增量落地 |
| `2026-11-11-memory-increments/` | 记忆系统 S1–S4 执行说明 + 合册交付记录 | 四轮全部完成 |
| `2026-11-08-studybuddy-implementation/` | 第一代 39 任务计划 —— **已归档** | 只剩 `00-discovery/` 证据与 `ARCHIVE.md` |

现行计划目录内的分工：

- `PLAN.md` — 目标、任务总表、依赖波次、不变量、v1 明确不做的范围
- `STATUS.md` — **唯一状态来源**：v0 基线、测试命令、任务状态表、交付记录指针
- `BOUNDARIES.md` — 已冻结的内核/服务/客户端契约，逐任务已知限制
- `AGENT.md` — 每个会话开工前必读的通用约定
- `tasks/T00–T20` — 单任务卡；只写要求，状态看 `STATUS.md`
- `issues/` — 2026-11-10 设计-代码复核发现的 21 个问题及修复卡、已接受范围

### `decisions/` — 决策记录（ADR）

| 文件 | 决策 |
| --- | --- |
| `layout.md` | 双主栏布局：路线 1/2 否决策略、选定中央列内第二主栏、核心补丁 ≤100 行 |
| `memory.md` | 不接入 `@restregular/dsh-memory`，在 study 插件内自建，理由与代价 |
| `goal-workspaces.md` | 一个备考目标可关联多个 DSH 工作区，只存工作区 id |
| `plugin-split.md` | 插件拆分边界：study / memory / followup / creator / platform 的归属 |

### 其余

| 路径 | 内容 |
| --- | --- |
| `backup.md` | 冷备份、校验、恢复与 JSON 数据导出的使用与边界（T17） |
| `creator.md` | 创造模式与四种模式切换的用法与限制（T16） |
| `manual/manual-start.md` | 手动启动与常见故障排查，含 Electron 权限修复 |
| `manual/operation-manual.md` | 面向使用者的完整操作手册（界面、流程、命令） |
| `design/2026-11-10-dsh-ui-references.md` | DSH 生态 12 个插件的 UI 调研与借鉴清单 |
| `notes/2026-11-09-project-model-config.md` | 项目模型与凭据配置的一次性记录 + 3 个证据 JSON |
| `plans/2026-11-08-.../00-discovery/` | A01 源码基线、A02 插件探针的原始证据（仍被 `STATUS.md` 与启动手册引用） |

## 3. 冲突时的优先级

1. `specs/` — 产品语义（用户可感知的行为）
2. `PLAN.md` §7 不变量 与 `BOUNDARIES.md` — 已冻结的实现契约
3. `STATUS.md` — 当前状态与证据
4. `decisions/` — 具体技术选型
5. `tasks/` — 执行要求；与 `PLAN.md` 冲突时以任务卡为准，但改范围要先改 `PLAN.md`

## 4. 历史与已移除的内容

2026-11-11 做过一次文档整理，删除的内容都能从 git 首个提交 `105bbae` 取回：

- **第一代 39 任务计划的任务卡与总纲**：已由 `2026-11-09` 计划取代，任务去向见 `PLAN.md` §12 的映射表；原文件删除，保留 `ARCHIVE.md` 与 `00-discovery/` 证据。
- **`design/refs/` 的 34 张参考截图（约 18MB）**：调研结论已写进 `2026-11-10-dsh-ui-references.md`，截图仅作配图。
- **记忆迁移前的数据库备份（约 5MB）**：`evidence/S3`、`evidence/S4` 的 `study.pre-s3/s4.db*`；迁移已完成，保留 `backup-manifest.json` 与演练报告。
- **`docs/superpowers/` 层级**：`plans/`、`specs/`、`notes/` 已上移一层，路径中的 `superpowers` 全部去掉。
- **`STATUS.md` 的重复交付日志**：与任务状态表内容相同，已删除；`§5 已知边界` 独立为 `BOUNDARIES.md`。

## 5. 维护规则

- `STATUS.md` 只写状态、证据与限制；新增边界写 `BOUNDARIES.md`，方案理由写 `decisions/`。
- 任务完成后更新 `STATUS.md` 对应行，不追加独立日志段。
- 新增文档放进上表中的对应目录，不要新建并列层级；放不下就先在本文件登记用途。
- 所有相对链接必须能打开；改目录后同步修正引用路径。
