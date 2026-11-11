# A02：DSH 主体扩展探针

仅用于验证固定 DSH 提交的接线，不是正式 StudyBuddy 插件，不进入运行包。工作区根目录没有 Git；所有探针代码在本目录，上游 checkout 保持干净。结论、失败记录和交接见 [extension-map.md](../../docs/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A02/extension-map.md)。

以下命令从 `D:/Data/ProjectsRepo/StudyBuddy` 执行。A01 已准备完整工件；如上游工件变更，先按上游要求重建。示例使用实测 Node 路径，避免当前沙箱账号的 nvm shim 未配置问题。

```powershell
$a02Node = 'D:/Applications/nvm/app/v26.13.0/node.exe'
& $a02Node probes/A02/run.mjs
```

命令保持运行，输出不含 token 的 `ready/root/origin`。在另一个终端按顺序执行：

```powershell
& $a02Node probes/A02/test-ui.mjs
& $a02Node probes/A02/test-cancel.mjs
& $a02Node probes/A02/test-attachment.mjs
```

这三个测试必须使用全新 mock run 并按顺序运行，因为 mock 依次返回插件工具、完成、慢流、完成。测试通过不等于真实官方模型通过。`test-attachment` 先填文本再选择文件，防止 `.fill()` 清掉附件 decorator。

停止并复测恢复：

```powershell
$a02Evidence = 'docs/plans/2026-11-08-studybuddy-implementation/00-discovery/evidence/A02'
$a02Run = Get-Content -Raw "$a02Evidence/local-running.json" | ConvertFrom-Json
New-Item -ItemType File -Path (Join-Path $a02Run.root 'stop') -Force | Out-Null
# 等启动终端退出，再复用这个 run；仅重命名本次 stop 文件，不移动或删除目录
Move-Item -LiteralPath (Join-Path $a02Run.root 'stop') -Destination (Join-Path $a02Run.root 'stop-before-resume')
& $a02Node probes/A02/run.mjs --resume --root $a02Run.root
```

在另一终端运行 `test-resume.mjs`、`test-interfaces.mjs`，结束后向 `resume-running.json` 的 root 写 `stop`。接口测试只创建、暂停、读取、删除一个 24 小时后的 Schedule，不投递、不唤醒模型。

独立原生工具和凭据行为测试：

```powershell
& $a02Node probes/A02/run.mjs --native --headless
& $a02Node probes/A02/test-credentials.mjs
```

桌面本地探针使用 `run.mjs --desktop`，等 `ready` 后执行 `test-ui.mjs --desktop`、`test-attachment.mjs --desktop`。本机在 managed sandbox 内出现 Electron 安装目录 AppContainer ACL 错误；同一命令在宿主环境运行通过，没有改 ACL 或关闭 Electron 沙箱。Windows 停止使用自有进程树 `taskkill`；沙箱内树终止可能被拒绝，应由宿主清理这些已登记的自有 PID。这不是优雅退出验收。

## 官方模型（需要用户授权及 Key）

2026-11-09 用户授权官方 Flash 4.1 1017，并在 A02 隔离 Electron GUI 保存了 Key。官方目录只公布 `deepseek-flash` / `DeepSeek-V4.1-Flash`；探针会查询目录并确认型号，不虚构独立 1017 pin。对新的执行会话应取得其自身的模型调用授权。

支持从当前进程 `DEEPSEEK_API_KEY`、专用 Key 文件 `A02_API_KEY_FILE`，或用户明确选定的 DSH 文档 `A02_DSH_CREDENTIALS_FILE` 读取。不要把 Key 放到命令参数或聊天。原生 `.credentials.yaml` 是明文，不能作为正式发行版的默认保护方案；本次官方新 profile 只用子进程环境，不再复制 Key。

```powershell
# 用户选定的已有 DSH 凭据文档路径，不是 Key 内容
$env:A02_DSH_CREDENTIALS_FILE = '<用户选定的隔离 home>/.credentials.yaml'
& $a02Node probes/A02/list-models.mjs
& $a02Node probes/A02/run.mjs --desktop --real
```

等待 `ready`，另一终端依次执行 `test-real.mjs`、`test-real-extra.mjs`。前者验证官方模型调用插件及原生 `read`，后者验证真实流式取消、合成文本/PNG 传递。关闭 thinking、输出上限 1024 token/请求、禁用会话上传和遥测。模型请求只有合成 fixture，不使用学生资料。

官方重启验证：停止官方 run，等启动终端退出，把该 run 的 `stop` 重命名后，以同一 `--root` 执行 `run.mjs --desktop --real --resume`；`A02_DSH_CREDENTIALS_FILE` 仍指最初用户选定的凭据来源，不能改指没有保存 API Key 的新官方 home。执行 `test-real-resume.mjs`；它只读取历史和插件状态，不提交模型请求。随后停止该 run。

`run.mjs` 的 `passed` 只表示 profile readiness；业务验收看独立的 `*-ui-result.json` 等报告。`*-running.json` 停止后只是历史定位信息，不表示进程还活着。运行数据和用户在测试窗口保存的凭据均在上游忽略的 `.desktop-build/a02/`，不能随证据导出。

## 文件

- `index.mjs`、`client.js`、`package.json`：最小服务、Agent 工具、页面及导航声明。
- `run.mjs`：从受支持 DSH profile 启动，隔离 home/agents/userData/默认工作区，清理继承凭据，保存脱敏日志。
- `test-ui`、`test-cancel`、`test-attachment`、`test-resume`：真实 Host/界面加本地 Messages fixture 的确定性测试。
- `test-real*`：授权后运行的真实官方桌面链路及恢复测试。
- `test-credentials`、`test-interfaces`：原生凭据行为与 Schedule 的限时接口探针。
- `credentials`、`official-model`、`list-models`：仅在内存处理 Key，查询官方型号；不处理 DSH 账号 token。
- `verify.mjs`：pin/hash、上游干净状态、报告、语法、引用和凭据排除检查。
- `inspect-ui.mjs`：初始页面诊断辅助脚本，非验收主流程。
