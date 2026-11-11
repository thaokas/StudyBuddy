# A02 实际命令与证据

工作目录为 `D:/Data/ProjectsRepo/StudyBuddy`，PowerShell。当前 sandbox 账号的 `node/pnpm` shim 起初报未配置 Node，因此采用已安装的 `D:/Applications/nvm/app/v26.13.0/node.exe`；没有修改全局 nvm、Git safe.directory 或系统 ACL。Git 只在单条命令使用 `-c safe.directory=<checkout>`。

| 命令（省略绝对 Node 前缀） | 最终退出/结果 | 证据 |
| --- | --- | --- |
| `probes/A02/run.mjs` | readiness 通过；自有 Host 后续终止，非优雅退出 | `local-result.json`、`local.stdout.log`、`local.stderr.log` |
| `probes/A02/test-ui.mjs` | 0；认证、UI 写入、Agent 工具写入、会话保持 | `ui-result.json`、`study-page.png`、`study-agent-shared.png`、`conversation-tool.png` |
| `probes/A02/test-cancel.mjs` | 0；部分流后取消 | `cancel-result.json`、`cancelled.png` |
| `probes/A02/test-attachment.mjs` | 0；文本/PNG 上传 200 | `attachment-result.json`、`attachments.png`；模型 wire 事实见 `local-result.json` |
| `probes/A02/run.mjs --resume --root <local-run>` | readiness 通过 | `resume-result.json` |
| `probes/A02/test-resume.mjs` | 0；同一 Session、历史、插件 rev2 | `resume-ui-result.json`、`resume-study.png` |
| `probes/A02/test-interfaces.mjs` | 0；非法值 400、Schedule CRUD | `interfaces-result.json` |
| `probes/A02/run.mjs --native --headless` | 0；从下一次模型请求确认 read 工具真实结果 | `native-result.json`、`native.stdout.log` |
| `probes/A02/test-credentials.mjs` | 0；synthetic 值明文落盘并移除 | `credentials-result.json` |
| `probes/A02/run.mjs --desktop` | sandbox 失败；宿主相同命令 readiness 通过 | `desktop-sandbox-result.json`、`desktop-sandbox-failure.log`、`desktop-result.json` |
| `probes/A02/test-ui.mjs --desktop` | 0；真实 Electron 插件/Agent/页面共存 | `desktop-ui-result.json`、`desktop-study-agent-shared.png` |
| `probes/A02/test-desktop-settings.mjs` | 0；原生设置页识别环境变量引用，不读取表单值 | `desktop-settings-result.json`、`desktop-model-settings.png` |
| `probes/A02/test-attachment.mjs --desktop` | 0；桌面附件两个上传 200 | `desktop-attachment-result.json` |
| `probes/A02/list-models.mjs` | sandbox EACCES；宿主 0；官方目录有 Flash 4.1，无单独 1017 ID | `official-model.json`、本次会话工具结果 |
| `probes/A02/run.mjs --desktop --real` | 宿主 readiness 通过；全新官方 run，Key 仅进程环境 | `desktop-real-result.json`、`desktop-real.stdout.log`、`desktop-real.stderr.log` |
| `probes/A02/test-real.mjs` | 0；官方工具与原生 read、流式、多步会话 | `real-ui-result.json`、`real-study-shared.png`、`real-conversation.png` |
| `probes/A02/test-real-extra.mjs` | 0；真实流式 `aborted/user`、文本/PNG 传递 | `real-extra-result.json`、`real-cancelled.png`、`real-attachments.png` |
| `probes/A02/run.mjs --desktop --real --resume --root <official-run>` | 宿主同数据根重启 | `desktop-real-resume-result.json` |
| `probes/A02/test-real-resume.mjs` | 0；三个测试回合、工具、附件回答、同一插件 rev2 恢复；此脚本模型调用 0 | `real-resume-result.json`、`real-resume-study.png` |
| checkout 内 `node node_modules/pnpm/bin/pnpm.mjs run build:check` | 0；host/client 两个 gate 通过 | `build-check.log` |
| `probes/A02/verify.mjs` | 最终核对见 JSON | `verification.json` |

构建检查前仅在该 PowerShell 子进程把已安装 Node 目录加入 PATH。工件来自 A01 的成功完整构建，本任务没有修改上游源码/配置/锁文件，因此未重复全量 build/测试。build:check 是在这些最新未变工件上运行；耗时 106.46 秒，2 passed/0 failed/0 skipped。

原生凭据来源是用户本轮在隔离 GUI 保存的文档，脚本仅把路径传给 `A02_DSH_CREDENTIALS_FILE`，未在命令行中传 Key。对应路径由 `desktop-ui-result.json.root` 加 `home/.credentials.yaml` 定位；新官方 run 则由 `real-ui-result.json.root` 定位。复现不应复制运行目录中的凭据到证据目录。

停止方法为向受控 run 写入 `stop`，runner 使用自有 launcher PID 的 `taskkill /T /F`（sandbox 内拒绝时 fallback `child.kill`，必要时宿主清理）。它不构成 H01 优雅退出验收。重启前只重命名同一 run 的 stop 文件，不移动/删除目录。完整复现顺序见项目根 `probes/A02/README.md`。
