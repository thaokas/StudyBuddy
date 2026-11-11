# S1：证据层与问答单元

> 本文件是给**新会话**的执行说明。开始前先读 `README.md`、设计与计划中的指定章节。只做本增量。

## 0. 一句话目标

让 StudyBuddy 从对话中稳定捕获学习回合，把同一会话切成“问答单元”，记录题目与信号，并提供一个可查询的 `study_questions` 工具。

完成后应能演示：两个会话、5 个用户回合 → 3 个问答单元、4 道题；重复投递不重复；重启后仍可查。

## 1. 开始前检查

全部满足才继续；任一不满足，停止并在交付记录里写明。

- `git status` 只含你自己的改动。
- `node --test plugins/study/tests/memory` 通过（15 项）。
- `plugins/study/host/modules/learning.mjs` 不存在。
- 已读：
  - 设计 `§4`（分层）、`§5.1–5.2`（表）、`§6.1–6.2`（捕获与切分）
  - 计划 `§3`（文件结构）、`§4 M1`
  - `plugins/study/host/index.mjs`（模块加载）、`registry.mjs`（命名空间）、`modules/memory.mjs`（模块写法）
  - `plugins/study/tests/memory/memory.test.mjs`（测试脚手架）

## 2. 范围

1. 新增 `learning` 命名空间与模块，建 11 张表（其中 3 张为 S2 预留，本增量只建不用）。
2. 订阅 `agent/inbox/claimed`，只处理 `message.source.kind === 'user'`。
3. 规则分类：学习 / 计划 / 反馈 / 情绪 / 闲聊。
4. 问答单元切分：同会话连续学习回合按边界分合并或切开。
5. 题目抽取、信号识别、重问检测。
6. 服务方法：`capture`、`list`、`get`、`stats`。
7. Agent 工具：`study_questions`（list / get / stats）。
8. 单元测试与 fixture。

## 3. 明确不做

- 不做窗口、摘要、主题线索（S2）。
- 不做画像、trait、注入（S3）。
- 不做分析报告、周报、保留清理（S4）。
- 不做任何界面（S2）。
- 不调用模型。
- 不改 `memory.json` / `memory.mjs` 的现有行为。
- 不改 DSH 源码。

## 4. 数据模型

在 `learning.mjs` 的 `schema` 数组中写以下 DDL（`STRICT`、`IF NOT EXISTS`）。`schemaVersion: 1`。

```sql
CREATE TABLE IF NOT EXISTS study_turn (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  turn_no INTEGER,
  at TEXT NOT NULL,
  intent TEXT NOT NULL,
  is_learning INTEGER NOT NULL,
  subject TEXT,
  text TEXT,
  text_hash TEXT NOT NULL,
  text_pruned_at TEXT,
  attachments_json TEXT,
  task_id TEXT,
  material_ref TEXT,
  episode_id TEXT,
  classified_by TEXT NOT NULL,
  classifier_version TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, message_id)
);
CREATE INDEX IF NOT EXISTS study_turn_at ON study_turn (goal_id, at);
CREATE INDEX IF NOT EXISTS study_turn_session ON study_turn (session_id, at);

CREATE TABLE IF NOT EXISTS study_episode (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  subject TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  status TEXT NOT NULL,
  problem_count INTEGER NOT NULL DEFAULT 0,
  stuck_json TEXT,
  method_json TEXT,
  resolution TEXT,
  confidence REAL,
  summary TEXT,
  boundary_source TEXT NOT NULL,
  continuation_of TEXT,
  merged_into TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS study_episode_at ON study_episode (goal_id, opened_at);

CREATE TABLE IF NOT EXISTS study_episode_problem (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  text TEXT,
  norm TEXT,
  hash TEXT NOT NULL,
  sketch TEXT NOT NULL,
  status TEXT NOT NULL,
  resolution TEXT,
  reasked_from TEXT,
  reask_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS study_problem_episode ON study_episode_problem (episode_id, position);
CREATE INDEX IF NOT EXISTS study_problem_hash ON study_episode_problem (hash, created_at);

CREATE TABLE IF NOT EXISTS study_episode_turn (
  episode_id TEXT NOT NULL,
  turn_id TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  role TEXT NOT NULL,
  ambiguous INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (episode_id, position)
);

CREATE TABLE IF NOT EXISTS study_signal (
  id TEXT PRIMARY KEY,
  episode_id TEXT,
  problem_id TEXT,
  turn_id TEXT,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  value_json TEXT,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS study_signal_episode ON study_signal (episode_id, at);

CREATE TABLE IF NOT EXISTS study_topic (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases_json TEXT,
  parent_id TEXT,
  material_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_episode_topic (
  episode_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (episode_id, topic_id)
);

CREATE TABLE IF NOT EXISTS study_capture_gap (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT,
  reason TEXT NOT NULL,
  detail_json TEXT,
  at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);

-- 以下 3 张表为 S2 预留，本增量只建表、不写入。
CREATE TABLE IF NOT EXISTS study_window (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL,
  cursor_json TEXT,
  summary_id TEXT,
  closed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS study_window_range ON study_window (goal_id, start_at);

CREATE TABLE IF NOT EXISTS study_window_summary (
  id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL,
  level TEXT NOT NULL,
  text TEXT NOT NULL,
  data_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS study_summary_window ON study_window_summary (window_id, created_at);

CREATE TABLE IF NOT EXISTS study_topic_thread (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 5. 接口

### 5.1 服务方法（`learning`）

| 方法 | 读/写 | 说明 |
| --- | --- | --- |
| `capture` | 写 | 内部：保存回合、分类、归入单元 |
| `list` | 读 | 单元列表，带题目摘要 |
| `get` | 读 | 单元详情：题目、回合、信号 |
| `stats` | 读 | 区间统计 |

`capture` 入参：

```json
{
  "sessionId": "string",
  "messageId": "string",
  "turnNo": 1,
  "text": "string",
  "attachments": [{ "type": "image", "name": "..." }]
}
```

返回 `{ "status": "created" | "duplicate" | "ignored", "turnId": "...", "episodeId": "..." }`。

`list` 入参：`{ from, to, subject, status, query, limit }`；`limit` 默认 20、最大 50。
返回 `{ items: [{ id, openedAt, closedAt, subject, status, problemCount, resolution, problems: [{ text, status, reaskCount }] }], total }`。

`get` 入参：`{ id }`。返回单元、题目、回合（`text` 可空）、信号。
`stats` 入参：`{ from, to }`。返回：
`{ turns, learningTurns, episodes, problems, resolved, unresolved, reaskRate, bySubject: [{ subject, episodes, problems }] }`。

### 5.2 工具 `study_questions`

`defineTool`，`action: list | get | stats`，其余参数同上。输出 `{ type: 'json' }`，`render` 用中文一行摘要（如“3 次问答，4 道题，2 次闭环”）。

## 6. 实现要点

### 6.1 捕获

```js
ctx.effect(() => ctx.on('agent/inbox/claimed', ({ agent, message }) => {
  if (message?.source?.kind !== 'user') return;
  const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (text === '') return;
  void ctx.study.call('learning', 'capture', {
    sessionId: agent.id,
    messageId: message.id,
    text,
    attachments: message.content.filter(b => b.type === 'image' || b.type === 'file')
      .map(b => ({ type: b.type, name: b.name ?? null })),
  }, { actor: 'system', requestId: `capture:${message.id}` })
    .catch(error => console.warn(`[study] capture failed: ${error instanceof Error ? error.message : String(error)}`));
}), 'study: learning capture');
```

- 只接受 `source.kind === 'user'`；`study-tutoring` 等注入消息直接忽略。
- 失败写 `study_capture_gap`，不抛给对话。
- `goalId` 用 `resolveActiveGoal(kernel.database) ?? 'unassigned'`。
- `subject`：查 `study_tutoring_link` + `study_task.subject`；无链接则 `null`。
- 幂等：先按 `(session_id, message_id)` 查；存在则返回 `duplicate`。

### 6.2 分类

优先级：反馈 > 问题 > 计划 > 情绪 > 闲聊。

- 问题：含 `? ？` 或 `怎么 为什么 这题 求解 证明 对不对 什么意思 思路`。
- 计划：含 `明天 后天 几点 安排 计划 推迟 取消 时间表` 且不含问题标记。
- 反馈：含 `懂了 明白了 没懂 不懂 再讲 太快 太难 清楚`。
- 情绪：含 `累 困 焦虑 烦 压力 睡不着`。
- `is_learning = intent === 'question' || taskId !== null || 有 image/file 附件`。

### 6.3 切分

对同一会话的**上一条学习回合**与当前回合算边界分：

```
+0.35 主题不相交（S1 无主题词典时用 subject 不同代替）
+0.20 字符 bigram Jaccard < 0.15
+0.15 边界词（再问一道/另一个问题/这题我会了/换个问题）
+0.10 材料或任务引用变化
+0.10 时间间隔 > 30 分钟
-0.30 续问词（那/这一步/为什么这里/还是不懂/再讲/然后呢）
-0.20 Jaccard > 0.45
-0.15 同 subject 且当前含续问词
```

- `≥0.5`：关闭当前单元，新建。
- `0.3–0.5`：并入，`study_episode_turn.ambiguous = 1`。
- `<0.3`：并入。
- 上一条不是学习回合、或间隔 > 30 分钟：直接新建。
- 单元内用户回合上限 8；超过时在边界分最低处强制新建。

### 6.4 题目

- 单元第一个学习回合：抽 1 道题。
- 后续回合含 `第[一二三四五1-5]题|另一道|顺便问|还有一道`：追加题目，最多 3 道。
- 题目文本截断 500 字；`norm` 去空白与标点；`hash = sha256(norm)`；`sketch` = 去停用词后词频最高的 8 个 token，空格连接。
- `problem.status` 初始 `open`。

### 6.5 信号与结果

- `understood`：`懂了|明白了|会了|清楚了|谢谢`
- `confused`：`没懂|不懂|不明白|还是不会|再讲|听不懂`
- `self_solved`：`我做出来|我算出来|自己解出来`
- `gave_up`：`不做了|放弃|太难了`
- 每条信号写 `study_signal`，`source='rule'`。
- 单元 `resolution`：有 `understood/self_solved` → `understood`；最后一条是 `confused` → `unresolved`；否则 `unknown`。

### 6.6 重问

新建题目时，在同 `goal_id`、近 90 天、其他单元中查找：

1. `hash` 相同；或
2. `sketch` Jaccard ≥ 0.8 且 `subject` 相同。

命中则：当前题 `reasked_from = 旧题 id`；旧题 `reask_count += 1`、`status='reasked'`；写 `reask` 信号到当前单元。

### 6.7 统计

`reaskRate = 有 reask 的题目数 / 题目总数`（无题目时为 0）。`bySubject` 按 subject 聚合，null 归为“未分类”。

## 7. 测试

新建 `tests/learning/`，复用 `tests/memory/memory.test.mjs` 的脚手架（临时目录、`openStudyDatabase`、`createKernel`、假 `ctx`）。假 `ctx` 需支持 `on`（记录 listener）、`tools.register`、`effect`。

至少 8 个用例：

1. 两个无关问题（换 subject + 边界词）→ 2 个单元。
2. 同题追问（“那这一步呢”）→ 1 个单元。
3. 同一 `messageId` 重复投递 → 只有 1 条 turn。
4. 计划消息不算学习回合，不建单元。
5. `source.kind='study-tutoring'` 被忽略。
6. 30 分钟间隔 → 新单元。
7. 同一题 3 天后再问 → `reaskCount=1`。
8. “第 2 题” → 同一单元 2 道题。

命令：

```powershell
node --test plugins/study/tests/learning
node --test plugins/study/tests
```

## 8. 验收

- 上述 8 个用例通过，且 fixture 中至少 7 个切分结果与期望一致。
- 现有测试全绿，`memory` 行为不变。
- `study_status` / `kernel.status` 能看到 `learning` 命名空间。
- 交付记录写明：切分规则的实际表现、已知误判、下一轮建议。

## 9. 交付物

- `host/modules/learning.mjs`
- `host/learning/text.mjs`（tokenize、bigram、sketch、hash）
- `host/learning/classify.mjs`
- `host/learning/segment.mjs`
- `host/learning/repo.mjs`（SQL 读写）
- `host/registry.mjs`（+ `learning`）
- `tests/learning/*.test.mjs`
- `S1-delivery.md`

## 10. 交接给 S2

S1 完成后，S2 应能直接使用：

- `study_turn` / `study_episode` / `study_episode_problem` / `study_episode_turn` / `study_signal`；
- `learning.capture/list/get/stats`；
- `study_questions` 工具。

**未提供**：窗口、摘要、主题、界面、合并/拆分。S2 负责补上，不要假设它们存在。
