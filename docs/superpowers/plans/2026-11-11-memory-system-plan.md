# 记忆系统实施计划：问答单元、画像与分析

日期：2026-11-11
状态：待评审；规模为粗估（±40%），以实际拆分为准。
设计依据：[`2026-11-11-student-memory-design.md`](../specs/2026-11-11-student-memory-design.md)

## 1. 交付范围

在 `plugins/study` 内完成四件事：

1. **问答单元**：会话 → 单元 → 题目的切分、合并、拆分与检索。
2. **窗口摘要与保留**：04:00 学习日、90 天正文保留、日/周摘要。
3. **学生画像**：七类记忆、trait 自动生效、教学契约注入。
4. **学习分析**：弱主题、方法信号、周报与周页展示。

不引入第二个业务插件、不引入向量库/图数据库、不改 DSH 核心。

## 2. 复用策略

### 2.1 结论先行

**不整包 fork 任何记忆插件**，只做**组件级移植 + 模式借鉴**。原因：

- 我们已冻结写入契约（`ctx.study` + `requestId` + revision + `change_log`），任何现成插件的 `memory_*` 工具都会绕过它；T20 已因此否决过 `@restregular/dsh-memory`。
- 现成插件没有“问答单元”“90 天保留”“trait 自动生效”“弱主题分析”，改造成本高于重写。
- 但它们的**检索、存储、提示词、预算**实现成熟，直接移植能省 8–10 人日。

### 2.2 逐项取舍

| 项目 | 许可 / 栈 | 取什么 | 方式 | 结论 |
| --- | --- | --- | --- | --- |
| [meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) `0.32.6` | MIT / Node + `node:sqlite` | `src/bm25.ts`（BM25 + 中文分词）、`src/prompts/**`（窗口整理提示词）、`src/inject.ts`（快照预算、压缩后重注入）、`src/db.ts`（去重/合并模式）、228 项测试中的检索用例 | **移植代码**，保留版权头，登记 `THIRD_PARTY_NOTICES.md` | 采用 |
| [dsh-memento](https://github.com/PerryLink/dsh-memento) | Apache-2.0 / Node | 服务内硬预算、`BUDGET_EXCEEDED` 结构化错误、审计行、会话内冻结快照 | **只借模式，不复制代码** | 采用 |
| [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) | MIT / Node 多包 | 运行时记忆 / 文档 / 记忆空间的三分；回合记忆条的信息架构 | 参考 | 不引入 |
| [memtrace](https://github.com/syncable-dev/memtrace-public) | 专有 EULA / Rust | 双时态字段设计 | 只借概念 | 不复制 |
| [deja-vu](https://github.com/vshulcz/deja-vu) | 需核对 / Go | 从已有会话历史补录 | 只借思路 | 不引入 |
| [ReMe](https://github.com/agentscope-ai/reme) | 需核对 / Python | Remember / Refine 两阶段 | 只借思路 | 不引入 |
| `dsh-memory-evolve` | — / Node | 无（功能面过宽，100+ 文件） | — | 不采用 |

### 2.3 移植清单（meow-memory）

| 源文件 | 落到 | 工作量 | 备注 |
| --- | --- | --- | --- |
| `src/bm25.ts`（20 KB） | `host/memory/bm25.mjs` | 1–1.5 人日 | TS→ESM，去掉 DSH 依赖，保留分词与打分 |
| `src/prompts/**` | `host/learning/prompts.mjs` | 1 人日 | 改成窗口摘要 / 单元 enrichment 的 JSON 契约 |
| `src/inject.ts`（31 KB） | `host/memory/inject.mjs` | 1 人日 | 只取预算与压缩后重注入，不取 UI |
| `src/db.ts`（43 KB） | 参考 | 0.5 人日 | 不整文件复制，只借鉴去重/合并/时间前缀 id |
| `test.mjs` 检索/去重用例 | `tests/memory/bm25.test.mjs` | 0.5 人日 | 改成 `node --test` |

> MIT 要求保留版权与许可声明；在 `THIRD_PARTY_NOTICES.md` 记录来源、版本、文件清单。

### 2.4 为什么不是“直接装 meow-memory 再补一层”

- 它自带 SQLite、工具、面板、设置页，数据与我们的 `study.db` 分离，备份/导出/对账会分裂成两套。
- 它的 `memory_*` 工具直接写自己的库，绕过 `requestId` 与 `change_log`，违反项目不变量 1。
- 它的七层语义与本设计的七类记忆不同（soul/project/rules vs trait/topic_state/strategy），映射会制造两套真相。
- 结论：装它省 2 天集成，却要多花 15 天处理契约、迁移与双写；不划算。

## 3. 目标文件结构

```
plugins/study/
  host/
    modules/
      learning.mjs        # 新：命名空间、事件钩子、工具
      memory.mjs          # 改：七类记忆、契约注入
      review.mjs          # 新：周报/月报
    learning/
      capture.mjs         # 回合捕获与分类
      segment.mjs         # 问答单元切分
      episode.mjs         # enrichment、合并/拆分
      window.mjs          # 窗口状态机、摘要、90 天清理
      analysis.mjs        # 弱主题、方法信号、证据包
      prompts.mjs         # 提示词与 JSON 校验
    memory/
      store.mjs           # item/evidence/tombstone（SQLite）
      traits.mjs          # Beta 模型、阈值、契约编译
      bm25.mjs            # 移植
      migrate-v1.mjs      # memory.json → 表
    registry.mjs          # 改：+ learning、review
  client/
    pages/
      memory.js           # 改：记忆 / 画像 两个 tab
      questions.js        # 新：问答记录（可延后）
      outcomes.js         # 改：周模式下的分析卡
    messages/
      memory.js           # 改：新文案
      questions.js        # 新
      outcomes.js         # 改
  tests/
    memory/               # 扩：trait、迁移、保留
    learning/             # 新：切分、窗口、分析
    review/               # 新：周报
```

## 4. 任务分解

### M0 基础设施与迁移骨架（3–4 人日）

- `registry.mjs` 增加 `learning`、`review`；`kernel.status` 可见。
- `learning` 模块骨架：`schema` 含全部新表，`schemaVersion: 1`；`memory` 改为真实 schema（此前为空，不会触发版本阻塞）。
- `Config` 增加 `features.memoryV2`（默认 `false`，M3 完成后打开）。
- `study_capture_gap` 表与状态输出。
- 迁移框架：备份 `memory.json` → `memory.v1.backup.json`，空库导入。

**验收**：插件正常加载；`study_status` 列出新命名空间；旧库打开不报 schema 冲突；备份文件生成。

### M1 捕获与问答单元（6–8 人日）

- `agent/inbox/claimed` 钩子；过滤 `study-*` 注入；`message.id` 幂等。
- 规则分类：学习/计划/反馈/情绪/闲聊；`classified_by` 可追溯。
- 切分算法（§6.2）：主题、bigram 相似度、边界词、时间间隔；模糊边界标记。
- 单元状态机：`open → closed → enriched`；关闭条件（会话结束/空闲 30 分钟/窗口关闭）。
- 合并/拆分/改主题的服务方法；`change_log` 记录。
- `questions` 页只读列表 + 搜索（可延后到 M5）。
- 测试：12 段构造会话的期望边界；重复投递不重复；注入消息被过滤。

**验收**：回放 fixture 切分准确率 ≥85%（人工标注）；捕获率 100%（对账零缺口）；重启不重复。

### M2 窗口摘要与 90 天保留（5–6 人日）

- 04:00 日窗口、周一 04:00 周窗口；`seal` 触发点（启动/空闲/晚间复盘后/退出）。
- enrichment：一次调用处理整窗新单元，输出题目/卡点/讲法/结果/主题；JSON 校验 + 一次重试 + 规则降级。
- 摘要存储、`input_hash` 版本化、`superseded_by`。
- 周摘要只读日摘要 + 主题聚合。
- 90 天清理任务：清 `text`/`problem.text`/`norm`，保留 `hash`/`sketch`/结构/摘要；面板提示。
- 测试：无 Key 规则摘要；清理后统计不变；重建一致。

**验收**：摘要可从 L0 重建；引用率 100%；90 天清理后弱主题仍可算。

### M3 画像 v2 与自动生效（7–9 人日）

- 七类记忆表；`memory.json` 迁移（保留 id/时间/来源/墓碑）。
- trait Beta 计算、置信度、半衰、±1 档/周。
- 自动生效规则（≥0.7 全量；0.5–0.7 仅表现顺序类；敏感项冷启动 3 单元/14 天）。
- 契约编译 + 注入（替换现有 `renderSnapshot`，保留空态兜底）。
- `memory` 页面新增“画像”tab；可改/可删/可否认。
- 测试：fixture 证据 → 期望档位；抖动上限；纠正后立即生效；墓碑不重建。

**验收**：同一题两次讲解的详细度差异可解释；自动生效无确认弹窗；纠正后下一轮生效。

### M4 学习分析（5–7 人日）

- SQL 统计：按周期/主题/意图；单元与题目计数。
- 弱主题公式 + 样本门槛 + 三态。
- 方法信号六条 + 反证。
- `study_insight` 工具（weak_topics / method_signals / review_build / review_save / profile）。
- 证据包构建（≤6k token）：画像、4 周统计、Top5 弱主题各 3 例、信号、摘要。
- 报告模板与“无能力诊断”约束。

**验收**：数字全部来自工具；每条结论有引用；`n<3` 不出排名；报告可存档对比。

### M5 周报与周页（4–5 人日）

- `review` 命名空间：`week` / `month` / `list` / `save`。
- 周报生成：周摘要后预生成；打开周页缺失时懒生成；幂等。
- `outcomes` 周模式新增“本周学习分析”卡（3 条要点 + 展开）。
- 无模型时规则版；i18n 文案；`questions` 页补齐（若 M1 未做）。

**验收**：周页可见；无 Key 有规则版；刷新不重复生成；旧页面不回归。

### M6 校准与交付（4–5 人日）

- 低详细度探针、衰减任务、用量统计。
- 导出（JSONL + Markdown）与恢复。
- 文档：设计/计划/决策记录、README 更新。
- 回归：现有 136 项 + 新增；headless mock e2e；Web 截图。

**验收**：全量测试通过；导出可读；决策记录落库。

## 5. 迁移步骤

1. 启动时检测 `memory.json` 存在且表为空 → 备份为 `memory.v1.backup.json`。
2. 逐条导入：`preference/state/observation` 映射原 kind，`goalId` 缺失填当前目标。
3. 墓碑导入 `study_memory_tombstone`，`content_hash` 保留。
4. `study_memory_state` 保留一个版本只读，确认后删除。
5. 校验：条数、抽样正文、墓碑抑制行为；失败回滚到备份并停用 v2。

## 6. 测试矩阵

| 层 | 用例 |
| --- | --- |
| 单元 | 切分边界；bigram/BM25；Beta 置信度；90 天清理；弱主题公式；方法信号阈值 |
| 集成 | headless + mock 模型：两会话捕获、单元合并、窗口摘要、契约注入、工具调用 |
| 端到端 | 周页卡片、记忆页画像 tab、问答页搜索、无 Key 降级 |
| 回归 | 现有 136 项；`tool-smoke` 更新；备份/恢复 |

命令：

```powershell
node --test plugins/study/tests/learning plugins/study/tests/memory
node --test plugins/study/tests
node plugins/study/tests/memory/tool-smoke.mjs
node plugins/study/scripts/build-client.mjs
```

## 7. 排期

| 周 | 单人 | 双人 |
| --- | --- | --- |
| 1 | M0 | M0 |
| 2–3 | M1 | M1 + M3 迁移部分 |
| 4 | M2 | M2 + M3 |
| 5 | M3 | M4 |
| 6 | M4 | M5 |
| 7 | M5 | M6 |
| 8 | M6 | 缓冲 |

总量 34–44 人日；单人 8 周，双人 4–5 周。

## 8. 风险

| 风险 | 触发 | 缓解 |
| --- | --- | --- |
| 切分准确率不达标 | 主题词典覆盖不足、短句多 | 词典 + bigram + 模糊复核；用户合并/拆分；阈值可配 |
| enrichment 成本高 | 每窗一次调用 | 空窗跳过、批量、规则降级、用量可见 |
| 自动生效抖动 | 证据噪声 | ±1 档/周、半衰、探针、可删 |
| 迁移失败 | 旧 JSON 异常 | 备份 + 只读校验 + 回滚 |
| DSH 事件变化 | 升级 | 固定 `0.2.2-rc.1`；钩子不可用时回退会话增量读取 |
| 页面回归 | outcomes 改动 | 只加卡片不改表；快照对比 |

## 9. 协同事项

- **`followup` 拆分**：本次只新建 `review` 承载报告；晚间复盘暂留 `followup`。拆分时把 `reviewAt` 逻辑迁入 `review`，不重复生成。
- **周页**：`outcomes` 的 week 模式加卡片，不改现有统计口径。
- **i18n**：新增 key 走 `client/messages/*`，`build-client.mjs` 要求页面与字典同名。
- **决策记录**：实施前补一条 ADR，记录 §2 的四处修订与“自动生效”的兜底。

## 10. 验收清单（DoD）

- [ ] 捕获率 ≥99%，对账缺口可见可补。
- [ ] 问答单元切分人工抽查 ≥85%，支持合并/拆分。
- [ ] 90 天清理后统计、弱主题、周报仍可用。
- [ ] 画像自动生效，纠正后下一轮改变讲法。
- [ ] 分析报告 100% 引用，无能力/心理诊断。
- [ ] 周页可见周报，无 Key 有规则版。
- [ ] 现有测试全绿，新增测试覆盖切分/迁移/清理/画像。

## 11. 渐进开发说明

四个新会话的执行说明见 [`2026-11-11-memory-increments/README.md`](2026-11-11-memory-increments/README.md)：

- `S1-evidence-layer.md`
- `S2-window-and-questions-ui.md`
- `S3-profile-and-tutoring-contract.md`
- `S4-analysis-and-weekly-review.md`

本批增量先实现确定性内核（不调用模型）；摘要叙述、报告润色等模型增强留到审核通过后再做。
