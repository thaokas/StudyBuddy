# 决策：学习记忆（T20）

日期：2026-11-10  
状态：已采纳（本地记忆模块）  
相关：`plugins/study/host/modules/memory.mjs`、`plugins/study/client/pages/memory.js`、`plugins/study/client/messages/memory.js`、`plugins/study/tests/memory/`

## 1. 结论

不接入 `@restregular/dsh-memory`，在 study 插件内实现本地记忆模块。零代码路线在功能上大体可用，但它不能满足本项目已经冻结的写入契约，也缺少 T20 明确要求的"来源"与"删除标记"。证据见 [`T20-memory-plugin-spike.json`](../superpowers/plans/2026-11-09-studybuddy-v1-plan/evidence/T20-memory-plugin-spike.json)。

## 2. 候选插件验证（隔离 profile）

| 项 | 值 |
| --- | --- |
| 宿主 | DSH `0.2.2-rc.1`，commit `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，Node `v26.13.0`，Windows x64 |
| 候选 | `@restregular/dsh-memory` `0.30.1`（npm；MIT；dshbase 未验证，★0） |
| 隔离方式 | 临时 `DSH_HOME` + `dsh plugin --profile headless add @restregular/dsh-memory`（exit 0）；未触碰 `.studybuddy` 桌面 profile |
| 安装结果 | profile `package.json` 增加依赖，`dsh.profile.bundles` 自动加入该包，bundle patch 插入 `id: dsh-memory` 一条 entry |
| 加载结果 | 真实 headless 会话启动成功，模型侧可见 6 个工具：`memory_save/search/list/get/forget/scopes` |
| 向量 | `retrieval.vector.enabled: false`；无网络请求，纯词法 |

功能 fixture（每个步骤都是独立进程，共 6 + 5 + 4 次冷启动）：

| 验收点 | 结果 | 证据 |
| --- | --- | --- |
| 中文保存偏好 | 通过："已保存记忆 `<uuid>` @ global" | `T20-memory-plugin-spike.json` → `functionalResults.savePreferenceGlobal` |
| 新会话召回偏好 | 通过：新进程的首个模型请求已带 `[全局/preference] 我更喜欢在上午学习数学。` 摘要，无需模型主动调用工具 | `crossSessionInjection` |
| 重启持久化 | 通过：JSONL 在独立进程间可见 | `revisionReadBack`、`fixtureAssertions` |
| 修订 | 通过：同内容保存回同一 UUID，`updatedAt` 变化并可 `memory_get` 回读 | `revision`、`revisionReadBack` |
| 短期状态到期失效 | 通过：`kind=state` 带过期时间，过期后 `memory_search` 返回"没有找到相关记忆" | `expiredStateHidden` |
| 中文词法召回 | 通过：`上午学数学` 命中数学偏好、`晚上背英语单词` 命中英语偏好，互不串；`lexical.assertions` 全 true | `chineseLexical` |
| 删除 | 通过（限定 `scope: "global"`）：`memory_forget({ query })` 默认只查当前 session，带错 scope 会 `RECORD_NOT_FOUND` | `delete` |
| 删除后重启不召回 | 通过：删除后新进程不再注入、搜索与列表为空 | `deleteAfterRestart`、`listAfterDelete` |

记录格式（`<storeDir>/global.jsonl`）：`{id, scope, kind, content, tags, source:{origin}, createdAt, updatedAt, importance}`；时间是 epoch ms。

## 3. 为什么仍不选零代码

功能 test 通过不等于满足本项目的边界。以下缺口来自源码/数据与项目约定，不是"没配好"：

1. **写入契约**：AGENT.md 不变量 1 要求"界面与 Agent 只经 `ctx.study` 写"。插件的 `memory_*` 工具与 `/memory/api` 直接写 JSONL，完全绕过 `requestId` 幂等、全局 revision 和 `change_log`；`kernel.status` 的命名空间里也不会有 `memory`（本地模块会注册）。
2. **来源字段不足**：记录只有 `source.origin = explicit|auto`。T20 要求"带时间与来源"，这里没有会话、轮次或引用来源，无法回答"这条记忆从哪句话来"。
3. **没有删除墓碑**：`memory_forget` 是硬删除，不写删除标记。T20 要求"删除标记优先于旧对话重建"；v1.1 一旦做批量提取，这个插件没有可供提取器检查的抑制接口。
4. **部署不可落地**：安装要向 profile 写依赖并跑包管理器；`scripts/project-config.mjs` 只会写 patch YAML，`scripts/start-studybuddy.mjs` 不安装 profile 依赖。零代码接入必须在 T20 所有权之外改启动器、profile 清单或发布打包。
5. **架构约定**：PLAN 3.1"不新增第二个业务插件"，本插件还自带 6 个模型工具、面板 HTTP 路由和一套向量子系统（本次关闭），权限面与测试面都超出 v1 需要。
6. **测试不可见**：它的测试全在上游仓库，`node --test plugins/study/tests` 覆盖不到；本项目无法用现有回归门禁防止升级回归。

插件本身质量不差，若将来允许第二个插件、且接受 JSONL 与 `ctx.study` 并存，可以重新评估；v1 不采用。

## 4. 本地实现

### 4.1 存储

`<dataDir>/memory.json`（与 `study.db` 同级），原子写：先写 `*.tmp`，再 rename；文件缺失视为空，JSON 损坏或版本未知时报 `unavailable` 并停止读写，绝不静默重置。

```json
{
  "version": 1,
  "updatedAt": "2026-11-10T01:00:00.000Z",
  "items": [
    {
      "id": "mem_0123456789ab",
      "kind": "preference",
      "text": "我更喜欢在上午学习数学。",
      "createdAt": "…",
      "updatedAt": "…",
      "expiresAt": null,
      "source": { "actor": "agent", "requestId": "…", "at": "…", "note": "…" }
    }
  ],
  "tombstones": [
    { "id": "mem_…", "contentHash": "sha256…", "deletedAt": "…", "source": { "actor": "ui", "at": "…" } }
  ]
}
```

- 三种 kind：`preference`（长期）、`state`（短期，默认 7 天，可用 `ttlMs` / `expiresAt` 覆盖，上限 90 天）、`observation`（待确认观察）。
- 没有计划/任务/完成量字段：`remember`/`recall` 只接受白名单字段，`plan`、`completed`、`progress`、`taskId` 等一律 `invalid`，不会复制学习数据。
- 上限：200 条、正文 500 字、墓碑 500 条；超限明确报错，不淘汰旧记忆。

### 4.2 删除抑制

`forget` 删除条目并写 `tombstones[{contentHash}]`（hash = 归一化正文的 SHA-256，不保存被删正文）。之后 `remember` 同样的正文默认返回 `status: "suppressed"`，不写盘；只有 `actor: "ui"` 且显式 `revokeTombstone: true` 才能恢复。因此旧对话可以再次"提到"这条内容，但无法把它写回记忆。

### 4.3 注入与工具

- `ctx.inject(['systemPrompt'])` → `systemPrompt.context({ name: 'study:memory', order: 500, text })`：每个会话的动态快照最多 8 条、每条 120 字，只含未过期条目，明确标注"不是计划或完成量"。DSH 的 runtime-context 投影只在文本变化时写一条 user 快照，不会每步重复。
- 服务命名空间 `memory`：`remember` / `recall` / `forget`；写方法 `remember`、`forget` 进入内核事务、revision 与 `change_log`。`change_log` 只记 kind、长度、hash，不复制正文。
- Agent 工具：`memory_remember`、`memory_recall`、`memory_forget`，与 UI 共用同一个服务。
- 中文召回：字符 + 双字 bigram + 拉丁词，按查询词权重计分（阈值 0.35），kind 标签参与匹配；这是词法召回，不声称语义检索。

### 4.4 界面

`client/pages/memory.js` 默认导出 `{ key: 'memory', order: 80, label: 'memory.panel', Page }`，文案在 `client/messages/memory.js`（T02 的构建脚本要求页面与字典同名配对）。页面支持查看、新增、纠正、删除、显示已过期；所有读写走 `POST /api/study/memory/<method>`，写操作自带 `requestId`。

## 5. 验收与复跑

```powershell
node --test plugins/study/tests/memory/memory.test.mjs   # 15 pass
node --test plugins/study/tests/kernel plugins/study/tests/memory   # 61 pass
node --test plugins/study/tests                           # 136 pass
node plugins/study/tests/memory/tool-smoke.mjs           # passed: true（真实 headless + mock 模型）
$env:STUDYBUDDY_T20_EVIDENCE="<path>/T20-memory-tool-smoke.json"; node plugins/study/tests/memory/tool-smoke.mjs
node plugins/study/scripts/build-client.mjs               # pages: memory, today
```

`tool-smoke` 覆盖：工具保存偏好 → 新进程首个请求带偏好 → 工具召回 → 删除 → 新进程不再注入 → 旧对话再记一次被 `未写入` 拒绝 → 新进程仍不注入。两次冷启动之间共享 `study.db` 与 `memory.json`。

## 6. 已知限制

- `memory.json` 的文件写入发生在内核 SQLite 事务内；若事务在文件写完后失败，文件会领先 revision。实际只剩 revision/meta 写入这一步，失败面很小，但严格意义上不是跨存储原子提交。
- 词法召回不是语义检索；换说法可能召不回，偏好依赖会话注入兜底。向量检索按 T20"不做"留到 v1.1。
- v1 不做自动批量提取；墓碑已经就位，v1.1 提取器必须查询它。
- 删除后正文不再保存在记忆文件与 change_log，但 UI 不提供"已删除列表"；恢复要靠用户重新记住同内容。
- `memory.json` 明文存放，未加密；数据目录权限是唯一保护。导出/备份由 T17 覆盖整个 `.studybuddy`。
- 记忆正文由学生或模型写入，注入时只作为"记忆事实"列出；没有做提示注入分类（例如一条记忆里写"忽略之前的指令"仍会进入上下文）。v1 不引入额外模型调用做判定。
- 相关会话刷新：项目内有并发任务改 `client/**` 时，先跑 `node plugins/study/scripts/build-client.mjs` 再启动应用。
