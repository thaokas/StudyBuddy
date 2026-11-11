# A02：验证 DSH 主体、前端扩展与桌面接入

大任务：A / 技术路线验证  
直接前置：A01  
状态：DONE

## 目标与输入

在 A01 固定的 DSH 上验证 S0 必需的桌面、模型、聊天/历史、基础工具和插件加载，并确认后续前端扩展方向。先读总览/RELEASES/执行规则/依赖表、A01 证据及该版本对应文档/实现。核心能力是 B01/R01 门槛；Schedule/通知/在线快照仅登记接口与缺口，正式验证由 F03/H01/H03 完成，不要求本探针修齐未来能力。

## 范围

仅制作最小探针：学习页占位、插件服务/工具调用、会话联动、独立 profile、调度和桌面桥接。产物放 `evidence/A02/` 及单独探针目录；不实现学习业务，不建设 SDK 独立前端。探针代码不得混作正式插件。

## 实施步骤

1. 先实测桌面启动、一个模型适配器的配置/对话、流式输出/取消、会话保存/重启、基础工具、附件传递和插件加载。模型付费调用须授权，原生凭据机制须记录保护方式；这些是 S0 核心矩阵。再定位插件生命周期、服务/工具、页面/上下文接口并记录例子。
2. 通过插件提供一个可打开的学习页和最小读写服务；从界面与 DSH Agent 工具分别调用同一服务。
3. 检查导航、对话布局、首次使用流程哪些可插件化，哪些需要改核心前端；提出最小扩展槽和改动清单，不只给截图。
4. 实测独立 profile/数据根和模型设置入口；对 Schedule、OS 通知/睡眠/退出和写入冻结/刷新做时间受限的接口调查。有结果则保存探针，缺失/未测明确转交 F03/H01/H03，不在 A02 实现完整适配。凭据证据必须脱敏。
5. 给出品牌、构建、更新来源的接入位置，区分已验证、需补薄桥接和阻断项。

## 验收

- 学习页与原有 DSH 对话共存，界面和工具可触达同一插件服务；有可复现代码和命令。
- 独立数据根不污染原 DSH；核心桌面/模型/对话/插件加载矩阵有真实结果。Schedule/通知/在线快照分别标通过、缺口或未测，未把 Schedule 当成系统通知服务。
- 核心前端扩展有逐项依据，Host/Agent 无需大幅重写；核心路线失败为 BLOCKED。未来功能缺口写明其阻塞的下游 ID，不把它误当成 S0 必交付项。
- 交付 `evidence/A02/extension-map.md`、探针测试、必要最小补丁和 B01/D01/H01 使用的真实接口清单。

## 交付记录

- 状态：DONE。A02 实施、真实模型/桌面核心矩阵与证据核对已完成；用户于 2026-11-09 确认可通过验收，已满足 [EXECUTION.md](../EXECUTION.md) 的集成人确认条件。
- 执行者/会话：Codex，2026-11-09。本轮仅执行 A02，未代做 B01/D01/H01 等生产任务。
- 实际基线与依赖提交：A01 已 DONE；固定 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，包 `0.2.2-rc.1`，Node 26.13.0 / pnpm 11.28.5 / Electron 44.7.0。外层非 Git，没有可提供的外层提交/分支；独立探针放在项目根 `probes/A02/`。上游 checkout 没有修改或新增提交，commit、锁文件/运行时 pin/许可哈希及干净工作树已重新核对。
- 改动文件与产物：本任务、[`evidence/A02/extension-map.md`](evidence/A02/extension-map.md)、[验证矩阵](evidence/A02/validation-matrix.md)、[命令与复现](evidence/A02/commands.md)、各 JSON/脱敏日志/截图，以及 `probes/A02/` 的 private 插件与测试。探针不作为正式插件、不进入发行包；没有更改公共契约、数据库迁移、Host/Agent 循环、上游前端或根依赖。
- 实现/验证结论：学习页及侧栏由现有 client slots 注册；与原生聊天往返保留同一 Session。界面与 Agent 的 `a02_probe` 调用同一 `ctx.a02Probe` 服务，先后写入、回读同一 revision。原生 `read(file_path)`、文本/PNG 附件、流式输出/取消、重启恢复均已验证。真实 Electron 走 `dsh-app://app/`，不是 SDK 独立界面；无需核心源码补丁。
- 真实模型授权与结果：用户明确授权官方 Flash 4.1 1017，并在本轮隔离 Electron GUI 保存 Key。脚本从该隔离凭据文档只读取 API Key，在新官方 profile 中仅注入子进程环境，不复制 Key 到新凭据文档/证据。官方 `/models` 返回 `deepseek-flash` / `DeepSeek-V4.1-Flash`，没有单独 `1017` 条目，因此未声称日期修订已 pin。见 [`official-model.json`](evidence/A02/official-model.json)。官方模型真实调用插件工具和原生 read，多步输出成功；取消日志为 `aborted/user`，附件请求完成且官方确认收到。详见 [`real-ui-result.json`](evidence/A02/real-ui-result.json)、[`real-extra-result.json`](evidence/A02/real-extra-result.json)。
- 重启与数据根：显式隔离 `DSH_HOME`、`DSH_AGENTS_HOME`、`DSH_DESKTOP_USER_DATA_DIR` 及首次默认工作区到 `.desktop-build/a02/<run>/`。停止全部自有桌面/Host 进程后复用同一官方 run，三个脚本测试回合（完成/取消/完成）、工具记录、附件回答、Session ID 和插件 rev2 均恢复；日志还保留一次额外完成回合。恢复测试不提交付费请求，见 [`real-resume-result.json`](evidence/A02/real-resume-result.json)。停止用自有 PID 树强制终止，不能当作优雅退出验收。
- 测试命令与结果：`run.mjs` 配合 `test-ui/test-cancel/test-attachment/test-resume` 的本地 Messages fixture 路径、`run.mjs --native --headless`、`test-credentials/test-interfaces`、桌面 UI/设置/附件、`test-real/test-real-extra/test-real-resume` 最终均通过；上游 `build:check` 退出 0，2 个 gate 通过。最终 [`verification.json`](evidence/A02/verification.json) 核对 15 份通过报告、18 个脚本语法、基线/哈希/上游干净状态、链接和真实 Key 排除。命令、初期失败与修正均保留，不把失败日志删除或改写成成功。
- 环境问题：Browser 扩展导航接口不可用，已按技能尝试并清理空标签，随后使用已有 Playwright 测试设施。Electron 在 managed sandbox 内被安装目录 AppContainer ACL 拒绝，宿主相同命令重试通过；没有修改 ACL、禁用 Electron 沙箱或变更 A01 Electron pin。首次隐式默认工作区访问失败后，探针显式隔离文档目录并重跑通过。
- 凭据与发行限制：synthetic 凭据测试确认原生 provider 明文 YAML 落盘、Windows 不做 POSIX owner-mode 检查。**B01/R01 须在 S0 发布前选择受保护存储或禁止持久化的会话凭据方案，不能推到 H02**。本次官方 profile 的 Key 不落盘，文本证据/探针扫描真实 Key 命中为 0；用户手动保存 Key 的最初隔离 runtime 不作为证据导出。S0 仍需由 B01/R01 阻止误接上游更新源、提供独立发行数据根与冷备份说明，本任务不放行安装器/更新。
- 未来能力与下游：Schedule 的真实 create/pause/view/delete 通过，但投递/去重/睡眠恢复交 F03；通用 OS 通知、suspend/resume、优雅退出桥接交 H01；API lock/drain 与 Domain.close 不能冒充跨存储一致在线快照，协调与正式验证交 H03。B01、D01、H01 的实际接口和最小改动逐项登记于 extension-map。这些未来缺口不反向阻塞 S0，核心 DSH 主体路线未发现阻断。
- 验收前补充调整：按用户要求新增持久化项目启动入口，保留原生自定义模型管理、禁用项目账号登录，并将此前保存的官方 Key 迁移到 Windows DPAPI 加密存储。真实自定义模型调用与原生模型管理验证通过，详见 [项目模型配置交接记录](../../../notes/2026-11-09-project-model-config.md)。以上补充发生在原 A02 基线验证之后；前述“上游干净、无需源码补丁”描述仅指原探针验证时点，当前桌面账号策略存在已记录的最小源码补丁。B01 需接收这些开发改动，R01 仍需完成正式运行包、发行检查并移除探针入口。
- 评审/集成确认：用户于 2026-11-09 表示“可以，我认为A02的任务似乎可以通过验收”，据此将 A02 从 REVIEW 更新为 DONE。产物已在当前共享工作区可用；外层非 Git，未执行合并或新增提交。未改变依赖结构或其他任务状态。A02 的前置验收已满足，可继续 B01；本确认不代表 R01/S0 运行包已经验收。
