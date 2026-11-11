# A02：固定 DSH 的扩展与桌面接入图

基线：`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，包版本 `0.2.2-rc.1`。执行日期：2026-11-09。代码在项目根 `probes/A02/`，是独立、private 的探针包，不是正式 StudyBuddy 插件。上游 Host、Agent 循环、前端源码及锁文件均未修改。

## 结论与证据级别

DSH 主体路线可用。学习占位页、原有对话、模型适配器、原生工具、附件及插件服务能够在同一个 Electron/Host/Agent 栈工作。界面写入 `real-ui-saved`，官方模型经 `a02_probe` 改为 `real-agent-saved`，界面随后读回相同 revision；同轮模型经原生 `read` 读取正确测试文件。见 [real-ui-result.json](real-ui-result.json)、[real-extra-result.json](real-extra-result.json) 和 [验证矩阵](validation-matrix.md)。

用户授权后，使用其在 A02 隔离 GUI 保存的 API Key 查询官方 `https://api.deepseek.com/models`，目录返回 `deepseek-flash` / `DeepSeek-V4.1-Flash`。请求走原生 `deepseek-official` 适配器及官方 `https://api.deepseek.com/anthropic`。目录未公布独立 `1017` ID，因此只确认当前官方 Flash 4.1 别名，不能声称锁定了 1017 日期修订；见 [official-model.json](official-model.json)。每次输出上限 1024 token，关闭 thinking、会话上传和遥测，仅提交合成测试资料。

原生凭据提供器会明文保存 Key；这不是加密存储。真实冒烟在新 profile 中仅通过子进程环境传入 Key，没有把 Key 复制进证据或新的凭据文件。**B01/R01 在 S0 发布前必须选择受保护存储或禁止持久化的会话凭据方案，不能等到 H02。** 这是发行集成要求，不需要重写 Agent。

## 实测接线

```text
DSH sidebar.panellist → main[a02-study] → authenticated Connection Fetch
                                            ↓
                                     ctx.a02Probe
                                            ↑
DSH Agent → ToolsService → a02_probe ─────────┘
```

| 接口 | 实际用法 | 所有者/依据 |
| --- | --- | --- |
| 插件启动 | `export const inject`、`apply(ctx)`；`ctx.provide('a02Probe', service)` | `vendor/cordis/src/fiber.ts`；探针 `index.mjs` |
| 资源生命周期 | 所有工具/路由通过 `ctx.effect()` 注册，返回 disposer；持久写队列在卸载时等待 | `AGENTS.md`、`packages/core/tools/src/index.ts`、`packages/client/connection/src/rpc-host.ts` |
| Host 的同一服务 | `read()` 返回 `{value,revision,writer}`；`write(value,writer)` 串行落盘后更新内存 | 探针 `index.mjs`；不构成正式业务契约 |
| UI 到 Host | `ctx.connection.fetch.register({path:'/api/a02.value',methods:['GET','POST'],requestBody:'buffered',fetch})` | `packages/client/connection/src/rpc.ts`；原生文件上传也使用这个注册点 |
| 认证 | Web 未认证 GET 返回 401；值类型错误返回 400；桌面 `dsh-app://app/` 走同一路由 | `ui-result.json`、`interfaces-result.json`、`desktop-ui-result.json` |
| Agent 到 Host | `ctx.tools.register(defineTool(...))`；`execute(args,exec)` 调用同一个 service，检查 `exec.signal` | `packages/core/tools/`；真实工具记录见 `real-ui-result.json` |
| 工具 schema | DSH ValueSchema DSL 的必填标志在属性上：`{type:'string',required:true}`；不能直接照搬 JSON Schema 根级 `required` 数组 | 首次误用已保留在 `first-host-schema-failure.log`；修的是探针 |
| 页面发布 | 包声明 `dsh.client.platform:'web'` 和 `exports['./client']`；Host `modules` 从活动 Loader entry 发布 client bundle | `packages/client/modules/src/index.ts`；探针 `package.json` / `client.js` |
| 学习页与导航 | `ctx.slots.inject('main', ...register({name:'main',key:'a02-study'},Page))`；侧栏注册 `sidebar.panellist` 同 ID | `packages/client/ui-layout/src/client/index.ts`；`ui-sidebar/src/client/index.ts` |
| 返回原会话 | `ctx.layout.selectPanel(null)`；全局 main 面板切换不删除会话 | `ui-layout/src/client/service.ts`；界面测试与重启证据 |
| 会话联动 | `ctx.sessions.list` 订阅目录；探针从 `row.retainedBy.mainView` 找主视图保留的 Session ID | `packages/api/session-controller/src/client/sessions/service.ts`；不要使用不存在的 `sessions.selection` |
| 正式 RPC | 业务服务用 `TypertRemoteService`、`@Remote`、生成的 host/client 描述与资源授权；已有 `session/create,prompt,selectModel,cancel,events,list` | `packages/typert/protocol/`、`packages/api/session-controller/src/index.ts`；探针 Fetch 路由不是正式公共业务 API |
| 历史/标题读取 | `session/events({address:{kind:'session',sessionId},maxMessages})` 返回 `records[].event`；`session/list` 的 wire Summary 标题是 `projections.values.title`，不是顶层 `title` | `packages/api/session-controller/src/types.ts`；`test-real-resume.mjs` 已实测 |
| 原生工具 | `read({file_path:<absolute path>})`，不是 `path` | `packages/fs/tool-fs/src/read.ts`；官方模型真实返回测试文件内容 |
| 附件 | composer 的 `input[type=file]` → `api/session/uploadFileBinary` → Session-owned receipt → prompt | `packages/client/file-upload/`、`ui-conversation/src/client/service.ts`；文本和 PNG 实测 |

生产插件应按上游 TypeScript/构建流程生成 client 与 Typert 工件。探针的手写 ModuleLoader fixture 沿用上游测试样例，仅为避免改工作区注册及锁文件。它没有实现多用户资源授权、数据库迁移、业务版本/幂等或通用事务，不能直接搬进发行包。

## 前端扩展决策与最小改动

| 需求 | 本提交已有扩展点/限制 | D01/D02/D04 的最小动作 |
| --- | --- | --- |
| 增加学习导航/页面 | `sidebar.panellist` 支持有序列表；`main` 是 keyed root slot；已实测 | 业务插件注册页面和入口；无需给核心侧栏写业务分支 |
| 保留自由聊天 | `main` 全局面板不自带 Session scope；`selectPanel(null)` 回原对话 | 使用 Session Controller 和 UI 导航服务，不另建聊天状态或 Agent |
| 学习信息与聊天同时可见 | 本探针验证的是两个主页面来回切换，未证明同时双主栏。现有 `rightbar` 已由 `ui-sidebar-right` 占用 | 先用 `ctx.sidebarRightTabs` 注册类型，再注册 `sidebar.right.pane.tab` 内容、通过 `ctx.sidebarRight` 打开；见其 `src/client/index.ts`。不要直接抢占 `rightbar`。若完整工作台必须常驻双主栏，D01 只给 `AppFrame`/layout 增加通用、可配置布局槽和尺寸规则；策略留插件，届时做布局测试 |
| 首次学习引导 | `ui-settings` 声明 `settings.onboarding`；`ui-settings-models` 注册欢迎/API Key 步骤，含 `credentialOnboarding` 配置 | D02 插件注册独立引导或页面，接入现有有序 onboarding；不把学习业务塞入原生模型凭据步骤 |
| 原生桌面欢迎页 | Electron shell 的 welcome/preload 与 Web 学习引导不是同一层 | 发行品牌/安全凭据入口如需变化，仅改 `apps/desktop/src` 对应欢迎壳；不动 Agent 循环 |
| 模型设置 | `settings.section`、`ui-settings-models`、`ctx.llm` 的 configurable providers；GUI 已识别环境变量引用 | H02 复用服务/设置页；B01/R01 先限定安全凭据存储方式，不能默认明文保存真实 Key |
| 任务上下文带入答疑 | `ctx.uiWorkspace.startSession/openSession`、`ctx.sessions`、`uiSession` 会话源注册；Host 的 `agent.inject()` 是写入日志的上下文入口 | D04/E03 声明自己的消息 source kind，复用已记录的注入；不要只改临时模型请求或靠隐藏前端变量影响模型 |
| 品牌 | 已有 `sidebar.brand.mark/name` slot；原生窗口/安装器品牌另属 shell/build | 插件替换品牌内容；窗口标题、应用 ID、图标、协议名和安装器在发行集成中统一处理，保留 MIT/第三方声明 |

目前不需要提交任何核心前端补丁。右栏/首次引导扩展只是源码确认，未作为探针已通过功能。若 D01 发现现有槽不足，改动应限于通用布局/上下文注入点并带复现，不能反向把所有 UI 做成 SDK 独立应用。

## 独立 profile、凭据与发行位置（B01）

启动仍走 `dsh` profile：源码 `node --import tsx/esm apps/cli/src/bin.ts web ...`，桌面 `pnpm run start:desktop`，没有新应用 bin。插入绝对路径插件的 overlay 由 launcher 解释；正式包应由 B01 安装为 bundle 并纳入解析图，不能把临时绝对路径作为产品依赖。

每次新建 `apps/desktop/.desktop-build/a02/<run>/`，分别指定 `DSH_HOME`、`DSH_AGENTS_HOME`、`DSH_DESKTOP_USER_DATA_DIR`；默认文档工作区通过 `workspace-controller.config.documentsDirectory` 也放入该 run。**DSH_HOME 不会自动隔离 Electron userData 或首次默认工作区。** 真实模型重启使用同一 run，以验证原数据，不与普通 `C:/Users/35373/.dsh` 混用。

`packages/credentials/credentials-local/src/index.ts` 的 `set()` 写 `.credentials.yaml` 的 `refs`；POSIX 提供 owner-only 模式检查，Windows 分支不验证 ACL，源码没有 at-rest 加密。`test-credentials.mjs` 只用 synthetic reference 验证写入/移除和明文事实。用户手动保存的真实 Key 只留在其选择的隔离 runtime；不提交、不导出。新的官方冒烟 profile 从进程环境解析 Key，证据最终扫描检查真实字符串未进入证据、探针或新凭据文档。

| 发行位置 | B01/R01/H04 应处理的内容 |
| --- | --- |
| `apps/desktop/scripts/dev.ts`、`.desktop-build` 路径工具 | 开发启动和 runtime 路径；产品包不能依赖本机 nvm/pnpm/源码 |
| `apps/desktop/scripts/electron-builder-config.mjs`、`electron-builder.config.mjs` | appId、productName、图标、协议、安装器、签名及发布配置 |
| `apps/desktop/src/update-settings.ts`、`update-channel.ts`、`update-coordinator.ts`、`main.ts` | 更新选择和安装流程；S0 禁止误连上游更新源。未在 A02 验收更新/安装 |
| `apps/desktop-host/src/index.ts` | 沿用共享 `runProfile`，负责 Host IPC 启停，不另起学习后端 |
| `apps/desktop/src/preload-app.ts`、`ipc.ts` | 只向受信 `dsh-app://app` 主文档提供 `dshDesktop`，新增平台桥也须校验 sender origin |

## Schedule、通知、生命周期和在线快照交接

| 能力 | A02 结果 | 现有接口与缺口 | 下游 |
| --- | --- | --- | --- |
| Schedule 管理 | **通过（仅 CRUD）** | 真实 `schedule/create` 建立 24 小时后的任务，随即暂停、view、delete；无提醒投递、无模型唤醒；见 `interfaces-result.json` | F03：补触发、去重、延后、时区/睡眠恢复测试 |
| Schedule 投递 | **未测** | `ctx.schedule`、`schedule/resolve-agent`、`schedule/run/history`；目标是 Session/inbox，不是 OS toast | F03/H01：不能将 Schedule CRUD 通过当成系统通知通过 |
| 通用 OS 通知 | **缺口** | `apps/desktop/src/update-attention.ts` 已使用 Electron Notification，但公开 `DshDesktopProductApi` 未提供业务通用通知服务 | H01 提供最小 notify/activate capability；F03 实现提醒策略与去重 |
| 睡眠/恢复 | **未测；需要桥接** | `main.ts` 有 `powerMonitor.resume` 用于更新检查，未发现公开给业务插件的成对 suspend/resume 服务 | H01：发布含时间信息的生命周期事件；F03/C05 重算提醒/计时，不由 shell 算学习策略 |
| 窗口关闭/退出 | **接口确认；未验收优雅退出** | 关闭可隐藏到托盘；`before-quit`/quit-confirmation、Host 的 shutdown IPC 已存在。探针停止使用自有 PID 树强制终止，只证明重启后的已提交数据恢复 | H01：用户退出/托盘/活跃任务/后台状态与清理的原生端到端测试 |
| 写入冻结/刷新 | **部分接口；无通用可恢复冻结** | `apps/desktop-host/src/update-tasks.ts` 的 `inspect/lock/unlock` 可拒绝新 HTTP API、等待已接纳请求并检查任务；不是插件后台写入屏障。`Domain.close()` 排空写入并关闭，非通用暂停后恢复 API | H01 提供受控平台协调入口；H03 定义所有存储参与者的 prepare/freeze/drain/snapshot/resume 协调 |
| 在线一致快照 | **缺口/未测** | 尚无跨 Session、study、memory、creator、attachments 的统一事务屏障；不能把复制文件或关闭单个 Domain 称为热备份 | H03；S0—S3 使用停止全部进程后的冷备份方案，由 R01/H04 整理 |

本表缺口不阻塞不包含这些未来能力的 S0；凭据保护和避免上游更新源则属于 S0 放行条件。Host/Agent 主循环没有已发现的路线阻断。

## 最小补丁清单与交接状态

已落地的唯一代码是独立探针及测试。上游补丁数量为 0。B01 消费本文件的启动/数据根/凭据/发行清单，D01 消费扩展槽与全局/会话 scope 区别，H01 消费公开 preload/IPC 与缺口表。探针中不包含正式学习业务、正式存储迁移、自动更新或完整备份适配。

复现命令见 [commands.md](commands.md) 和项目根 `probes/A02/README.md`。状态与最终评审仅以 [A02 任务](../../A02-dsh-extension-spike.md) 为准。
