# StudyBuddy 文档索引

本目录放 **产品语义、现行架构与契约、设计规范、决策记录与操作手册**。代码不在这里：代码在 `plugins/`、`packages/`、`scripts/`、`tests/`、`platform/` 与固定源码 `source/deepseek-harness`。

> 2026-11-17 做过一次归档：**已完成的开发计划、任务卡、状态与证据**（原 `plans/`、`notes/`、`manual/manual-start.md`、两份一次性调研）已删除，只保留仍对维护者有效的文档。需要历史细节时从 git 历史取回，不在 docs 继续维护。

## 1. 我想知道什么，读哪份

| 想知道什么 | 读这里 |
| --- | --- |
| 项目怎么启动、数据目录在哪、怎么验证 | [`../README.md`](../README.md)（项目入口） |
| 开发环境怎么从零搭、日常怎么启动、怎么跑测试 | [`development.md`](development.md) |
| 产品要做成什么样、用户可感知的行为 | [`specs/2026-11-08-studybuddy-redesign-design.md`](specs/2026-11-08-studybuddy-redesign-design.md)（整体产品设计）、[`specs/2026-11-11-student-memory-design.md`](specs/2026-11-11-student-memory-design.md)（学习记忆） |
| 系统现在怎么搭、插件怎么分层、数据怎么存 | [`architecture.md`](architecture.md) |
| 命名空间 / 方法 / 表所有权 / 工具 / 路由 / 页面 / profile 行冻结成什么 | [`contracts.md`](contracts.md) |
| 还剩哪些工作、哪些明确没做 | [`roadmap.md`](roadmap.md) |
| 布局为什么这样、核心补丁是什么 | [`decisions/layout.md`](decisions/layout.md) |
| 学习记忆为什么自建、不接第三方插件 | [`decisions/memory.md`](decisions/memory.md) |
| 目标为什么可以关联多个 DSH 工作区 | [`decisions/goal-workspaces.md`](decisions/goal-workspaces.md) |
| 插件为什么分层而不是完全解耦 | [`decisions/plugin-split.md`](decisions/plugin-split.md) |
| 外观插件（配色 / 顶栏 / 设置行）怎么设计 | [`design/appearance-plugin.md`](design/appearance-plugin.md) |
| 桌宠「小搭」（状态机 / 台词 / 形象）怎么设计 | [`design/study-pet.md`](design/study-pet.md) |
| 各插件页面的排版、滚动与视觉规范 | [`design/2026-11-17-study-page-redesign.md`](design/2026-11-17-study-page-redesign.md) |
| 怎么使用界面、各功能怎么操作 | [`manual/operation-manual.md`](manual/operation-manual.md) |
| 备份、恢复、JSON 导出的口径 | [`backup.md`](backup.md) |
| 创造模式怎么用、有哪些限制 | [`creator.md`](creator.md) |

## 2. 文档树

```text
docs/
  README.md                  # 本索引
  architecture.md            # 高层架构：运行时 / 插件行 / DAG / 数据 / 服务面 / 客户端 / 决策 / 边界
  contracts.md               # 插件拆分后的冻结契约 v1（取代旧 shell 描述）
  roadmap.md                 # 剩余工作：P7、T18、T19、低风险项、未实现产品项
  specs/
    2026-11-08-studybuddy-redesign-design.md   # 整体产品设计（DSH 宿主、学习闭环、14 场景）
    2026-11-11-student-memory-design.md        # 学生记忆系统设计（问答单元、画像、分析）
  design/
    2026-11-17-study-page-redesign.md          # 插件页面视觉改版规范（Pi 式共享样式层）
    appearance-plugin.md                       # 外观插件设计规范（6 套配色 / 三面 / 对比度）
    study-pet.md                               # 桌宠设计规范（状态机 / 台词 / 静图形象）
  decisions/
    layout.md                # 布局：双主栏路线否决与最小核心补丁
    memory.md                # 学习记忆：不接第三方插件、自建记忆模块
    goal-workspaces.md       # 目标与 DSH 工作区关联
    plugin-split.md          # 插件拆分与依赖模型：分层 DAG
  manual/
    operation-manual.md      # 面向使用者的完整操作手册
  backup.md                  # 冷备份、恢复与 JSON 导出
  creator.md                 # 创造模式与模式切换
  development.md             # 开发与测试手册（由开发文档维护）
```

## 3. 文档冲突时的优先级

1. **代码**是最终事实。文档与当前代码不一致时，先确认“代码是预期的还是文档是预期的”。
2. [`specs/`](specs/) —— 产品语义（用户可感知的行为）。
3. [`contracts.md`](contracts.md) —— 已冻结的实现契约（命名空间、表、工具、路由、页面、profile 行）。
4. [`architecture.md`](architecture.md) —— 现行结构的解释（怎么搭、为什么这样分层）。
5. [`decisions/`](decisions/) —— 历史技术选型及其理由；旧 shell 路径与已删除探针属于历史记录。
6. [`roadmap.md`](roadmap.md) —— 剩余工作与未实现项，不作为已完成能力的依据。

冲突处理：如果实现要改契约，先改 [`contracts.md`](contracts.md) 并说明；如果是产品语义变化，先改 [`specs/`](specs/)；接口 / 表 / 页面 / 行的具体值只认 `contracts.md`。

## 4. 维护规则

- **不再新增已完成计划 / 任务卡 / 证据目录**。一次性的开发计划、验收证据与状态记录放到仓库外或 git 历史中，不进入 docs。
- 新增文档只放进上表已有目录：产品语义 → `specs/`，设计规范 → `design/`，技术选型 → `decisions/`，使用说明 → `manual/`；跨目录的新层级先在本文登记用途。
- 改接口 / 表 / 页面 / profile 行时，同步更新 [`contracts.md`](contracts.md)；改分层或数据流时同步 [`architecture.md`](architecture.md)；完成 / 新增剩余工作项时同步 [`roadmap.md`](roadmap.md)。
- 所有相对链接必须能打开；移动文件后同步修正引用路径。根 `README.md`、`manual/operation-manual.md`、`backup.md`、`creator.md`、`development.md` 由对应维护者负责，本索引只做入口。
- docs 里的页面 key、侧栏 order、locale NS、profile 行 id 是契约值，不要为了文案好看而改。

## 5. 历史说明

本次归档删除的内容（均可从 git 历史取回）：

- `docs/plans/**`：v1 功能计划（T00–T20）、记忆系统四轮增量、插件拆分 P0–P7 计划与证据、外观 / 桌宠并行计划与验收、第一代 39 任务归档。
- `docs/notes/**`：项目模型与凭据配置的一次性记录及证据 JSON。
- `docs/manual/manual-start.md`：A01 基线时期的早期手动启动指南，功能已由 [`manual/operation-manual.md`](manual/operation-manual.md) 与 [`development.md`](development.md) 覆盖。
- `docs/design/2026-11-10-dsh-ui-references.md`、`docs/design/2026-11-14-dsh-appearance-plugins-research.md`：已落地的一次性 UI / 外观 / 桌宠生态调研。

保留的结论已经并入现行文档（架构、契约、设计规范、ADR 与路线图），不依赖被删除文件。
