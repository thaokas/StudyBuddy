# SB-19 创建计划：表单起手 + 对话协作生成

- 状态：DONE（2026-11-11）
- 优先级：P1
- 来源：用户 2026-11-11 需求（4 条约束）；issue 18；设计 §4.1、§4.2
- 依赖：SB-01（任务/时间块/计划条目统一事实）、SB-05（当前目标作用域）
- 预计：2–3 个会话
- 所有权：
  - `plugins/study/host/modules/planning.mjs`（新，模块 id `planning`）
  - `plugins/study/host/prompts/plan-creation.md`（新，创建计划专属提示词）
  - `plugins/study/host/modules/materials.mjs`（只增 `study_goal` 工具）
  - `plugins/study/client/pages/onboarding.js`、`client/messages/onboarding.js`（改造为创建计划）
  - `plugins/study/client/plugin.js`（`activity.startPlanCreation` 接线）
  - `plugins/study/tests/planning/**`（新）、`tests/onboarding/**`（改）、`tests/materials/goal-tool.test.mjs`（新）
  - 本卡、`issues/tasks/README.md`、`STATUS.md`
- 开工阅读：`issues/README.md`、`issues/tasks/11-onboarding-conversation.md`、设计 §4.1–§4.2、`AGENT.md`

## 1. 用户要求（原话转成产品约束）

1. 「开始」页改成「创建计划」：用户仍像现在这样手动填写必要信息，填完由 agent 根据这些信息开始工作。
2. 不新增 skill；把现有「开始」功能改造成「创建计划」；新增/修改的提示词与工具都放在 study 插件内。
3. 创建计划专属提示词要引导 agent 主动询问、和学生以探讨的方式完成计划。
4. 计划的修改使用现有功能（计划页确认/撤销、工作台改任务与时间块），与创建功能解耦。

## 2. 现状与差距

| 现状 | 差距 |
| --- | --- |
| `onboarding.js` 四步：目标 → 材料 → 草案 → 确认；草案只能写一条任务 | 没有 agent 参与；填不出完整计划 |
| 页面只写「在对话里说：帮我按……排一份计划」的示例文案 | 不创建会话、不注入上下文，用户要自己复制一句话 |
| `study_plan` 有 draft/confirm，但没有「怎么谈」的提示词 | 模型每轮自由发挥，容易一次问太多、重复问、漏阶段/周目标 |
| Agent 无法读取或保存备考目标 | 对话里不能核对/修改考试日期、每天可用时间 |
| 计划页已有草案确认、容量检查、撤销；工作台可改任务/时间块 | 修改能力已存在，缺的是与创建流程的明确分工 |

## 3. 目标体验

1. 打开「创建计划」页，按现有方式填：目标（考试/年份/日期/每天可用分钟/备注）→ 选材料 → 填计划需求（标题、阶段目标、限制、备注）。
2. 点「让助手开始规划」→ 主区域切到新对话，输入框预填一句开场白（可改后回车）。
3. 对话里同时出现一条**折叠的上下文**（`study-planning`，用户可展开查看），内容 = 表单快照 + 创建计划提示词；用户不必读它。
4. agent 先读目标、材料、本周安排，再用探讨式提问（每轮 1–2 个问题、给选项、说明取舍），逐步把计划谈清楚。
5. agent 调 `study_plan(draft)` 产出草案，给出摘要与容量结论；学生继续提修改，改的是同一份草案。
6. 学生明确同意后 agent 调 `study_plan(confirm)`；也可以让学生去「计划」页确认（现有功能）。
7. 之后要改计划：走计划页撤销/重排、工作台改任务与时间块，**不再经过创建流程**。

## 4. 方案

### 4.1 页面结构（改造 `onboarding.js`，不新建页面）

步骤从 `goal → materials → draft → confirm` 改为 `goal → materials → brief →（交给助手）`，原有 `draft/confirm` 保留为**降级路径**：

| 步骤 | 内容 | 说明 |
| --- | --- | --- |
| `goal` | 现有目标表单 | 不变：考试、年份、日期、每天分钟、备注；保存即 active |
| `materials` | 现有材料选择 | 不变：关联已导入材料，可空 |
| `brief`（新） | 计划标题（默认「{考试} 学习计划」）、阶段目标/想达到的效果、每天可用分钟（用目标值预填）、固定安排或限制、备注 | 只写学生确定的部分；空字段不阻塞 |
| `draft`（降级） | 现有草案表单（一条任务） | 入口改为 brief 页的次按钮「不用助手，自己写草案」 |
| `confirm`（降级） | 现有确认界面 | 保持不变；agent 生成的草案回到页面时也走这里 |

- `resolveStep`：`storedPhase === 'brief'` 回到 brief；有未确认草案 → confirm；正式修订 > 0 → done；否则 goal。
- 文案：`onboarding.panel` 改为「创建计划」，标题改为「创建学习计划」，副标题说明「先填必要信息，助手会和你一起谈出计划」；保留「稍后继续」「跳过引导」。
- 降级路径是为了满足既有不变量「无 Key/断网时本地功能可用」：没有模型时仍能自己写草案并确认。

### 4.2 点「让助手开始规划」的时序（`client/plugin.js` → `activity.startPlanCreation`）

顺序固定，避免「用户先发消息、提示词后到」的竞态：

```js
// plugin.js 已有 ctx.inject(['uiWorkspace','workspaces','sessions','layout'])
activity.startPlanCreation = async (brief) => {
  const workspace = (workspaces[0]) ?? await scope.workspaces.initializeDefault();
  if (!workspace) throw new Error(t('plan.notice.noWorkspace'));
  // 1) 先建/复用空白会话：只创建，不显示
  const sessionId = await scope.uiWorkspace.connectWorkspace(workspace.workspaceId);
  // 2) 先落库关联（此时还没有任何一轮对话，后续 pre-step 才能拿到提示词）
  await call('planning', 'start', { sessionId, goalId, brief, requestId: randomUUID() });
  // 3) 打开会话（replaceMain 同步 retain，随后 binding 可用）
  scope.uiWorkspace.openSession(sessionId);
  // 4) 预填一句开场白，学生可改后回车
  const binding = scope.sessions.binding(sessionId);
  const conversation = scope.get('conversation');
  if (binding && conversation) {
    conversation.input.requestDraftInitialization(binding, { prompt: seed, whenDraftExists: 'append' });
  } else {
    // 兜底：页面提示学生自己说一句「帮我创建学习计划」
  }
};
```

- 提示词不是靠 `agent.inject` 塞进收件箱，而是在 `agent/pre-step` 瀑布里、该会话**第一轮第一步**把快照 + 提示词作为 `user/message` 追加进这一步（与 `skill`/`skill-invocation` 注入同一机制）：只要能拿到 link，第一轮请求就一定能看到提示词；注入后 `injected_at` 置位，后续轮次不重复。
- 因此第 2 步必须早于用户发第一句话：`start` 成功前不打开会话，用户没有机会抢跑。
- `start` 失败就停在创建页提示可重试，不打开一个没有提示词的对话。
- 预填而不是自动发送：`requestDraftInitialization` 是 DSH 自己的「打开带草稿会话」路径，学生可见可改；自动发送列为二期。

### 4.3 创建计划专属提示词（`host/prompts/plan-creation.md`）

由 `planning.mjs` 读取，和表单快照拼成一条上下文消息，在创建会话第一轮第一步由 `agent/pre-step` 追加，`source = { kind: 'study-planning', form: 'instructions', version }`。正文中文，结构：

1. **角色与目标**：你是学习计划助手；目标是把计划谈清楚，不是一次问完。
2. **已知信息**（由代码填入表单快照）：考试、年份、考试日期、每天可用分钟、计划标题、阶段目标、限制、备注、已选材料；明确标注「未填写」的项不要当成已知。
3. **开场动作**：先调 `study_plan get`、`study_materials list`、`study_tasks week`、`study_goal get`；已有未确认草案时在草案上继续，不从零重来。
4. **探讨式提问**：
   - 每轮最多 2 个问题，优先问「会明显改变安排」的缺口。
   - 给 2–3 个选项或默认建议，说明时间/容量的取舍，而不是开放式盘问。
   - 工具已读到的信息不重复问；学生答不上来就记假设并继续。
5. **生成规则**：条目 25–90 分钟、一条一个可完成结果、跨章节拆条、先修写 `dependencies`；有把握才排日期，否则 `date: null` 并说明未安排；`availability` 逐日写分钟；页码/题号没有证据就标 `locator.unverified`。
6. **完成定义**：阶段目标、当前周周目标、可执行条目（含预计分钟与完成标准）、排期或明确的未安排、假设与限制、容量结论。
7. **呈现与确认**：先给 4 行摘要（期限/每天可用/条目与总分钟/容量结论），再列改动与风险；学生明确同意后才 `confirm`；需要试行时先解释再 `trial: true`；不自动确认、不声称「已保存」。
8. **交接**：确认后告诉学生去「计划」页看修订、去「工作台」改任务；后续修改不再经过本流程。
9. **边界**：不改考试目标（除学生明确要求并确认）、不编造材料内容、不替学生降低目标。

> 为什么不用 skill：本流程只服务一个入口，提示词随会话注入即可，不占常驻目录预算，也不需要在 profile 里注册；工具与提示词同属 study 插件，符合第 2 条约束。

### 4.4 新工具 `study_goal`（`materials.mjs`）

- `action`：`get` | `list` | `save`；`save` 字段：`id`、`exam`、`examYear`、`deadline`、`dailyMinutes`、`note`、`active`、`requestId`。
- `get` 省略 `id` 读当前激活目标；`save` 有 `id` 时先读现状再做**字段合并**（服务端 `saveGoal` 是整行覆盖，直接传部分字段会清空其他字段），写操作带 `requestId`。
- 返回目标摘要（含 `missing`），供 agent 核对和补全。
- 只调用现有 `materials.getGoal/saveGoal/listGoals`，不新增服务方法。

### 4.5 数据表 `planning`（`planning.mjs`）

```sql
CREATE TABLE IF NOT EXISTS study_planning_link (
  session_id  TEXT PRIMARY KEY,
  goal_id     TEXT,
  snapshot    TEXT NOT NULL,   -- 表单快照 + 提示词正文（注入内容）
  digest      TEXT NOT NULL,
  version     INTEGER NOT NULL,
  injected_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS study_planning_link_goal ON study_planning_link (goal_id, created_at);
```

服务方法：`start`（写：落库快照 + 摘要）、`pending`（读：是否有待注入快照，避免普通会话第一步提交写事务）、`claim`（写：原子读出待注入的 link 并置 `injected_at`，没有则返回 null）、`get`（读：按 sessionId）、`close`（写：解除关联，不删历史消息）。注入由模块注册的 `agent/pre-step` 瀑布完成（只在 `turn === 1 && step === 1` 时先 `pending` 再 `claim`，命中就把消息追加到这一步；`next()` 必须先调用）。

只存「用户填了什么 + 要注入什么」，不存计划内容——计划仍只存在 `study_plan_draft`/`study_plan_revision`。

### 4.6 与修改解耦

- 创建：填表 → 对话 → 草案 → 确认（对话或计划页）。
- 修改：计划页撤销最近修订 / 工作台改任务与时间块 / 进度记录。本卡不改这些功能，也不给创建页加编辑能力。
- 创建页只读展示当前草案/计划的摘要与「去计划页」提示，不提供编辑。

## 5. 文件清单

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `host/prompts/plan-creation.md` | 新增 | 提示词正文（约 120 行，含 §4.3 全部条目） |
| `host/modules/planning.mjs` | 新增 | 表、`start/claim/get/close`、`agent/pre-step` 注入、快照与提示词拼装 |
| `host/modules/materials.mjs` | 修改 | 新增 `study_goal` 工具（约 70 行，含字段合并） |
| `client/pages/onboarding.js` | 修改 | 新增 `brief` 步与「让助手开始规划」；草案步降级为次入口；`resolveStep` 更新 |
| `client/messages/onboarding.js` | 修改 | 页面更名、brief 文案、按钮与错误提示（中英） |
| `client/plugin.js` | 修改 | `activity.startPlanCreation`（约 20 行） |
| `tests/planning/planning.test.mjs` | 新增 | link/claim/pre-step 注入/幂等/重启/错误路径/快照与提示词拼装 |
| `tests/materials/goal-tool.test.mjs` | 新增 | `study_goal` get/save/list、合并、校验、幂等 |
| `tests/onboarding/onboarding-ui.test.mjs`、`ui-smoke.mjs` | 修改 | brief 步、handoff 回调、降级路径、文案；真实 UI 冒烟补一步 |
| `issues/tasks/README.md`、`STATUS.md` | 修改 | SB-19 索引与验收记录 |

## 6. 测试与证据

1. `node --test --test-isolation=none plugins/study/tests/planning`
   - `start` 落库快照；同快照重复 `start` 幂等；`close` 后 `claim` 返回 null。
   - `claim` 原子：第一次返回快照并置 `injected_at`，第二次返回 null；重启后仍不重复。
   - `agent/pre-step` 只在该会话 `turn 1 / step 1` 追加消息一次；`next()` 被调用；拒绝分支不追加。
   - 注入消息：`source.kind === 'study-planning'`、`form === 'instructions'`，正文含表单快照、提示词版本与关键段（「探讨」「完成定义」）。
   - 非法 payload（缺 sessionId、未知字段、缺 goal）拒绝且不改库。
2. `node --test --test-isolation=none plugins/study/tests/materials` — `study_goal` 工具。
3. `node --test --test-isolation=none plugins/study/tests/onboarding` — 新步骤机、brief 提交、降级草案/确认路径、存储续填、文案。
4. `node --test --test-isolation=none plugins/study/tests/client` — 构建新鲜度与全量字典键。
5. `node plugins/study/scripts/build-client.mjs` — 重建 `client/client.js`。
6. `node plugins/study/tests/onboarding/ui-smoke.mjs` — 真实 Host + Edge：打开「创建计划」→ 填目标/材料/brief → 点按钮 → 对话打开且输入框有开场白（若模型不可用则断言降级路径）。
7. 整套 `node --test --test-isolation=none plugins/study/tests`。

## 7. 验收标准

- [ ] 侧栏与页面标题显示「创建计划」；四步变三步，草案/确认仍可用（降级）。
- [ ] 填完目标、材料、brief 后点「让助手开始规划」：对话打开、输入框预填开场白、会话收到一条 `study-planning` 上下文。
- [ ] 上下文内容 = 表单快照 + 提示词；提示词要求主动询问、每轮 ≤2 问、探讨式取舍、完成定义、确认前不声称保存。
- [ ] agent 能读当前目标（`study_goal get`）、在对话里改目标并落库（`study_goal save`），改了之后容量按新目标计算。
- [ ] agent 产出的草案能在计划页看到并确认；确认后生成修订，工作台出现任务与时间块。
- [ ] 修改计划只走计划页/工作台；创建页不含编辑入口。
- [ ] 无模型时：填表 → 自己写草案 → 确认，仍能完成创建。
- [ ] §6 命令全部有输出记录；`client/client.js` 与源码同步。

## 8. 不做

- 不做运行时 skill、不新增插件、不改 DSH 源码。
- 不做默认备考会话映射、目标上下文常驻注入（SB-11 其余部分）。
- 不做滚动 7 天细化、估算校准（SB-18）。
- 不做草案级人工编辑（工作台已能改确认后的任务；草案编辑另行立项）。
- 不自动确认计划，不自动发送开场白（预填后由学生回车）。

## 9. 风险与降级

| 风险 | 处理 |
| --- | --- |
| `sessions.binding`/`conversation` 在打开后仍拿不到 | 会话已打开并已关联，提示词仍会在第一轮注入；页面提示学生自己发一句「帮我创建学习计划」 |
| `planning.start` 失败 | 不打开会话，停留在创建页并提示可重试（避免开一个没有提示词的对话） |
| 提示词被模型忽略 | 上下文里放「完成定义」清单；工具校验兜底；冒烟用 mock 模型断言上下文出现在请求里 |
| 提示词过长挤占上下文 | 正文 ≤ 150 行；快照只放已填字段 |
| 与并行改动冲突 | 实现前重读 `onboarding.js`、`plugin.js`、`client/messages/onboarding.js`；只改本卡所有权路径 |
| 现有 onboarding 测试大面积失效 | 保留 `draft/confirm` 代码与测试，只新增 brief 步；逐条更新步骤断言，不重写整套 |

## 10. 待确认（默认值）

1. **手动草案是否保留为降级入口**：建议保留（无模型可用；否则违反「本地功能可用」不变量）。
2. **开场方式**：建议预填 + 学生回车（可改可看）；不做自动发送。
3. **创建页是否显示「继续创建对话」**：建议一期不做（计划页已能确认草案；继续对话可直接在会话列表找到），二期再加。
4. **提示词语言**：中文（与现有工具描述、用户语言一致）。

## 11. 完成后

1. 记录 §6 命令与结果、真实 UI 冒烟截图（如做）。
2. 更新 `STATUS.md` 与 `issues/tasks/README.md`。
3. 在 `docs/decisions/` 记录「提示词注入 vs skill」的选择理由（如已有 decisions 目录约定则并入）。

## 12. 完成记录（2026-11-11）

**实现**

- `host/prompts/plan-creation.md`：中文提示词模板（角色、铁律、开场动作、提问顺序、生成规则、完成定义、呈现与确认、失败降级），`{{KNOWN_INFORMATION}}` 由代码替换。
- `host/modules/planning.mjs`：`study_planning_link` 表 + `start/claim/get/close`；`agent/pre-step` 只在 `turn 1 / step 1` 注入一次（`source.kind = study-planning`、`form = instructions`）；模板在加载时读取，缺失即加载失败。
- `host/modules/materials.mjs`：新增 `study_goal` 工具（get/list/save；`save` 先读现状再合并；不传 `workspaceIds` 即保持原关联）。
- `host/registry.mjs`：命名空间表增加 `planning`。
- `client/pages/onboarding.js`：三步 `goal → materials → brief`；brief 表单与「让助手开始规划」「不用助手，自己写草案」；`resolveStep` 支持 brief 与旧的手动 draft/confirm；`parseBrief`/`defaultBriefDraft`/`emptyBriefDraft` 导出。
- `client/lib/plan-creation.js`：`connectWorkspace → planning.start → openSession → requestDraftInitialization` 的固定顺序（可单测）。
- `client/plugin.js`：注入闭包里装配 `activity.startPlanCreation`。
- `client/lib/api.js`：`planning` 写方法加入客户端幂等映射。
- `client/messages/onboarding.js`：页面更名「创建计划」、brief 文案、种子开场白、错误与降级文案（中英）。

**测试**

- 新增 `tests/planning/{helpers,planning.test}.mjs`（14 例）：link 幂等/刷新、claim 一次、重启、非法载荷、pre-step 只注入一次、未关联会话不注入。
- 新增 `tests/materials/goal-tool.test.mjs`（7 例）：空目标、建档缺字段、字段合并、工作区保留、切激活、callId 幂等、错误信息。
- 新增 `tests/client/plan-creation.test.mjs`（7 例）：顺序、默认工作区、无工作区、start 失败不打开、缺 binding/conversation 的降级、预填抛错不影响交接。
- 更新 `tests/onboarding/onboarding-ui.test.mjs`（58 例）与 `tests/kernel/registry.test.mjs` 的命名空间表。
- `tests/materials/helpers.mjs` 增加 `toolNamed`（附加、兼容原 `tool`）。
- `tests/onboarding/ui-smoke.mjs`：改为「创建计划」流程（目标 → 材料 → brief → 暂不创建 → 刷新 done → 计划页），并给种子路由补 `requestId`、`expectedDraftRevision`、`draftId`（修 SB-03/SB-08 之后漂移）。
- `tests/plans/tool-smoke.mjs`：补 `expectedDraftRevision`（同为既有漂移）。

**结果**

- `node --test --test-isolation=none plugins/study/tests`：593 例 592 pass / 0 fail / 1 skip。
- `node --test --test-isolation=none plugins/study/tests/planning plugins/study/tests/materials/goal-tool.test.mjs`：15/15（planning 8 + goal 7）。
- `node --test --test-isolation=none plugins/study/tests/client`：67/67。
- `node plugins/study/scripts/build-client.mjs`：退出 0，`client/client.js` 430480 字节。
- `node plugins/study/tests/kernel/loader-smoke.mjs`：`passed: true`，moduleIds 含 `planning`。
- `node plugins/study/tests/onboarding/ui-smoke.mjs`：`passed: true`，截图 4 张（goal/brief/done/plan）在 `tests/onboarding/evidence/`。
- `node plugins/study/tests/plans/tool-smoke.mjs`：`passed: true`。

**偏差与限制**

- 同时改了共享文件 `host/registry.mjs`、`client/lib/api.js`、`tests/kernel/registry.test.mjs`、`tests/materials/helpers.mjs`（均为单点追加，必要）。
- 真实模型点击级端到端未跑：`ui-smoke` 未配置模型，只覆盖到 brief 页与按钮；提示词注入由单测的 `agent/pre-step` 覆盖。
- 创建页没有「继续上次创建对话」；继续对话走会话列表。
- 没有实现草案级人工编辑；创建后的修改仍走计划页/工作台。
