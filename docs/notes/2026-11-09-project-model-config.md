# 项目模型配置与启动入口

日期：2026-11-09。此变更承接 A02 之后的用户要求，不修改 A02 的历史结果或测试入口。

用户要求保留 DSH 原生模型设置和自定义模型功能、取消项目中的 DeepSeek 账号登录，并使用此前在 GUI 保存的官方 API Key 预置项目自定义模型。

## 实现

- 日常入口改为根目录 `start-studybuddy.cmd`，调用 `scripts/start-studybuddy.mjs`。数据持久保存在 `.studybuddy/`，与本机 `~/.dsh`、A02 的一次性目录隔离。无自动退出定时器。
- 原生 `llm-pi-ai` 自定义提供商 `studybuddy-deepseek` 走官方 Anthropic 兼容接口，模型 ID 为 `deepseek-flash`。官方列表没有独立的 `1017` ID。模型设置沿用原生界面与 `settings/mutate`。
- 仅首次创建 profile 的模型配置，默认 High；原生界面之后编辑的模型、提供商和档位均持久保留。已验证用户选择的 Low 在重启后保留。
- 项目禁用账号提供器、账号模型、账号控制器、账号页面与相关远程日志/遥测。桌面壳新增显式 `DSH_DESKTOP_ACCOUNT_ENABLED=0` 策略，跳过账号引导与账号 RPC；省略开关保留上游默认行为。
- 原生凭据服务替换为 `platform/windows-credentials`，实现同一 CredentialProvider 接口。API Key 与记录使用当前 Windows 用户 DPAPI 加密，跨进程锁加原子替换保存；设置页仍可修改 Key。锁等待默认为 120 秒。
- 从 A02 证据指向的旧 GUI 凭据文件执行一次迁移；配置文件只保存凭据引用。导入使用原生安全解析器，错误输出不引用密钥行。未读取本机账号记录作为 API Key。
- 学习页继续加载 A02 的插件占位页，尚非完整学习功能。

源码在 `source/deepseek-harness` 的 `task/studybuddy-model-config` 分支修改，基础提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，未提交。改动限于桌面账号策略、双语文档及回归测试；自定义模型界面没有改写。

## 验证

- 源码 `build:artifacts`：8 个 gate 通过。
- 源码 `build:check`：2 个 gate 通过。
- 桌面账号策略、welcome host、welcome startup：3 个测试文件，14 个测试通过。
- 项目配置与加密凭据：5 个测试通过，覆盖首次初始化、保留界面修改、重启、并发写入、长刷新写锁和导入错误脱敏。
- 实际 Electron：原生自定义提供商临时新增、编辑、删除成功；原自定义模型保留；账号接口返回 404；无登录引导。
- 真实调用通过：使用项目加密凭据、原生自定义适配器和官方 Flash 模型，合成测试会话正常完成并收到预期回复。测试会话已归档。只读复查证据见 [real-smoke.json](evidence/2026-11-09-project-model-config/real-smoke.json)，不包含 Key，也没有额外请求模型。
- 项目凭据存储检查：扫描新代码、修改的上游文件、项目 home 和启动日志，共 40 个文件，未发现真实 Key 明文；项目未生成原生明文凭据文件。原 A02 导入来源不纳入扫描，结果见 [credential-storage-check.json](evidence/2026-11-09-project-model-config/credential-storage-check.json)。
- 只读代码复查发现的导入错误泄密风险和锁等待过短问题均修复并补充回归测试，复查未发现剩余阻塞问题。

当前使用与限制见根目录 README。启动脚本依赖已安装并构建的源码工作区；加密凭据目前仅支持 Windows。A02 旧凭据文件是用户原先保存的明文来源，迁移没有删除该文件。
