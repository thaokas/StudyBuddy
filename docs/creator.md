# StudyBuddy 创造模式与模式切换

> 适用版本：v1（T16）。DSH 版本固定在 0.2.2-rc.1；创造能力来自 DSH 实验组合包
> `@deepseek-ai/dsh-personalized-recommendations`，不是 StudyBuddy 自己实现的生成器。

## 1. 日常模式和创造模式

平时用**标准模式**答疑；需要“做一个能一直用的页面/小工具”时，显式切到**创造模式**。

| 界面名称 | 预设 id | 适合 |
| --- | --- | --- |
| 标准模式 | `standard` | 日常答疑、代码、文件、资料，默认模式 |
| PTC 模式 | `ptc` | 批量调用工具后筛选、整理、统计 |
| 极简模式 | `minimal` | 用终端和读图做基础测试、对比 |
| 创造模式 | `cordis` | 让 Agent 编写并安装 DSH 插件、页面或自定义模式 |

- **默认是标准模式**。DSH 的 `agent-preset-registry` 配置里默认值就是 `standard`；
  新建任务时输入框上方的模式按钮显示「标准模式」。
- **创造能力在首次启动时启用**。启动器把
  `@deepseek-ai/dsh-personalized-recommendations` 写入隔离 profile；之后可以在
  「插件」页像其它官方组合包一样关闭它，关闭后下次启动仍保持关闭。要重新启用，
  删除 `<数据根>/home/.studybuddy-creator-enabled` 后重启，或在插件页重新打开。
- **创造模式必须显式切换**。在新任务的模式按钮里选「创造模式」，或在
  「设置 → Agent 预设」里选「创造模式」；插件页的「让 Agent 创建插件」也会进入
  同一个流程。不做“问一句就自动切创造”的隐式行为。
- **切换只影响后续请求**。选择发生在会话开始前；已经跑过一轮的会话保持启动时的
  预设，Host 会拒绝中途换预设（历史里的工具与提示词不能混用）。新任务使用新选择；
  默认值本身只有点「设为新任务默认」才会改。

## 2. 创造模式里会发生什么

1. 你明确要一个页面或小工具（例如“做一个按周汇总错题数的清单页”）。
2. Agent 先在回答里给出方案，回答末尾出现一张**创建卡片**；卡片可以改位置、展开
   预览方案、看“创建需要较长时间和较多 token”的说明，或点「暂不」。
3. 只有点 **Create（创建）** 才会在后台启动 Creator 子 Agent（使用 `cordis` 预设）
   生成真正的插件包。生成阶段可以取消；生成完成由 Host 校验包身份、补丁和构建
   入口，然后复制到 profile 并安装。
4. 卡片显示 **Installed（已安装）** 后，按你选的位置出现页面/标签/侧栏。关闭或离开
   会话不会卸载已完成的插件；重启 StudyBuddy 后仍在。
5. **Undo（撤销）** 卸载该插件并移除它的界面；**Restore（恢复）** 用保留的 profile
   副本重新安装，不重新生成。失败、被中断、被取消都有状态和重试入口，不会静默变成
   成功。

位置有三种，卡片里可以改：

| 位置 | 效果 | StudyBuddy 建议 |
| --- | --- | --- |
| 会话标签页（`page`） | 当前会话里 Chat / Trajectory 旁多一个标签 | 清单、图表等跟本次学习任务绑定的内容 |
| 左侧全局页（`sidebar-left`） | 左侧栏入口打开一个主区域页面 | 要跨会话反复打开的记录 |
| 右侧栏（`sidebar-right`） | 对话旁的窄栏 | 需要边聊边看；窗口变窄时内容要能压缩 |

也可以在卡片里「自己写位置」。无法用现有 DSH 扩展点实现的位置会明确失败，不会
悄悄换一个位置。

## 3. 生成页面能读什么

生成的页面（插件）**只能经学习服务**读写数据：

- 浏览器半边：`POST /api/study/<namespace>/<method>`，同源 cookie 鉴权，成功
  `{ ok: true, value, revision }`，失败 `{ ok: false, code, message, details }`。
- 宿主半边：`ctx.study.call(namespace, method, payload, { actor })`。
- 允许的只读名称空间：`kernel`、`tasks`、`plans`、`materials`、`outcomes`、
  `followup`、`timer`、`memory.recall`。
- 写入只在需求明确时发生，并带 `requestId` 与读到的 `expectedRevision`；冲突时
  显示服务消息让学生重试，不覆盖新修订。

生成页面不得打开 `study/study.db`、`study.db-wal`、`study/memory.json`、
`home/credentials.dpapi`、会话日志或 `request_log`，也不得把凭据写进页面/日志。
详细示例见 `plugins/study/creator/skills/study-creator/references/data.md`。

**权限说明**：安装后的插件和 Creator 现有权限相同，**不是沙箱**。本项目只承诺
“可移除、可撤销”，不承诺受限执行、权限最小化或代码审计。

## 4. 学生可以怎么问

- 日常：“帮我讲一下这道导数题。”——标准模式，直接回答，不产生创建卡片。
- 记录：“做一个按日期列出今天学习块和完成状态的清单页，放在左侧，能一直打开。”
- 图表：“做一个本周各科学习时长柱状图，跟着当前会话，数据从学习服务读。”

如果只需要一次性表格或文件，直接要文件即可；创建卡片是给“以后还要反复用”的页面。

## 5. 参考文件挂在哪里

| 仓库路径 | 运行时位置 |
| --- | --- |
| `plugins/study/creator/skills/study-creator/` | `<数据根>/home/skills/study-creator/` |

启动器（`scripts/project-config.mjs` 的 `prepareProfile`）每次启动都会把参考复制到
DSH 的 user skill root。DSH 的 cordis 预设扫描这个目录，所以 Creator 子 Agent 能
通过 `skill` 工具加载 `study-creator`，再用相对路径读 `references/` 下的两份参考。

同一个技能条目也会出现在日常模式的技能目录里（DSH 的 user skill root 对所有预设
可见），这是已知限制；它只是一份参考，不会自己生成卡片。创建卡片只有在模型加载
`personalized-pages` skill 后才会进入工具列表，日常答疑的门槛没有降低。

## 6. 失败与恢复

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| 卡片显示失败/已中断 | 生成未完成、包校验失败或 Host 安装失败 | 在卡片上重试；仍失败时把上方说明发回对话 |
| Create 不可用 | 当前会话不是活的根会话、没有 profile 修改权限，或会话是只读沙箱 | 回到主会话、确认不是只读模式后重开卡片 |
| 提示名字或位置不支持 | 卡片方案与可实现的 DSH 扩展点不符 | 改位置或改描述后重新提案 |
| 撤销后想再用 | 已卸载 | 点 Restore；源文件仍在时不需要重新生成 |
| Restore 被拒绝 | 保留下来的 profile 副本缺失或校验失败 | 重新提案一个新页面 |
| 日常模式没有创建卡片 | 日常答疑不触发，这是设计；标准模式明确要求页面时仍可能出卡片 | 切到创造模式再要页面 |

## 7. 验证命令

```powershell
# 配置、skill、参考与文档的一致性
node --test --test-isolation=none plugins/study/creator/tests

# 启动器写出的隔离 profile 能解析三层 bundle、6 个 creator 行与 skill
node plugins/study/creator/tests/profile-compose.mjs

# 真实 Host + 浏览器：模式切换、生成、安装、重启、撤销、恢复、失败提示
node plugins/study/creator/tests/creation-smoke.mjs

# 既有回归
node --test --test-isolation=none plugins/study/tests
node plugins/study/scripts/build-client.mjs
```

冒烟脚本报告与截图在 `plugins/study/creator/evidence/`。创造流程需要真实 Host、
Edge（Playwright）与宿主进程权限，因此脚本不命名为 `*.test.*`，不进入
`node --test`。

## 8. 已知限制

- 创建能力来自 DSH 实验特性；DSH 升级后要重跑一次本页的冒烟。
- 创建卡片是 profile 级实验特性，标准模式的技能目录里仍能看到 `personalized-pages`；
  所以标准模式的**日常答疑**不触发卡片，但学生明确要求“做一个页面”时仍可能出现
  卡片。T16 没有按预设禁用这个特性（那需要改 DSH preset 声明，超出本任务所有权）。
- 模型是否提议创建卡片仍取决于语义判断；本页不承诺每次都能识别“需要页面”。
- 只支持新建插件，不支持在卡片里修改已有插件；没有版本历史，Restore 只认卡片
  记录的那一份 profile 副本。
- 撤销不删除源码：工作区的 `.dsh-created-plugins/<id>` 和 profile 的
  `created-plugins/<id>` 会保留；需要彻底清理时由学生手动删除。
- 生成插件安装后就属于这个 profile，**没有独立的撤销历史**；数据备份与导出仍按
  `docs/backup.md` 执行，生成插件的源码不在 `study.db` 里。
- 如果安装包不是从 DSH 源码树启动（未来打包版），官方 bundle 的解析来源可能不同，
  需要按发布流程重新验证。
