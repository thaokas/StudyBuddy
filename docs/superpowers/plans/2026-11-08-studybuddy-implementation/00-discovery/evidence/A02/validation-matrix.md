# A02 验证矩阵

固定提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，Windows x64、Node 26.13.0、pnpm 11.28.5、Electron 44.7.0。测试发生于 2026-11-09；JSON 的 `started/finished` 使用 UTC。

| 验收项 | 本地 fixture /真实 DSH | 官方模型/桌面 | 证据 |
| --- | --- | --- | --- |
| 桌面启动、进入主界面、加载探针 | 通过；沙箱内 Electron ACL 失败，宿主重试通过 | 通过，`dsh-app://app/` | `desktop-ui-result.json`、`real-ui-result.json`；保留 `desktop-sandbox-result.json` |
| 模型适配器配置/调用 | 通过；原生 DeepSeek Messages 适配器连 loopback fixture | 通过；官方 `deepseek-official` → `deepseek-flash` / Flash 4.1 | `official-model.json`、`real-ui-result.json`；1017 日期修订未独立确认 |
| 流式输出 | 通过；mock 实际发送 SSE | 通过；3 次 assistant/message 的 stream 分别 9/6/5 条 | `local-result.json`、`real-ui-result.json` |
| 取消 | 通过；UI 显示“已停止”，mock stream cancelled | 通过；已见 `0001:` 部分输出后点击停止，日志 `aborted/user` | `cancel-result.json`、`real-extra-result.json` |
| UI/Agent 共用服务 | 通过；UI rev1 → Agent rev2 → UI 回读 | 通过；`real-ui-saved` → `real-agent-saved` | `ui-result.json`、`desktop-ui-result.json`、`real-ui-result.json` |
| 页面与原生聊天共存/会话联动 | 通过；页面切换保留同一 Session | 通过；官方工具调用沿用原生聊天 | `study-agent-shared.png`、`real-study-shared.png`、`real-conversation.png` |
| 原生安全工具 | 通过；headless 的原生 `read` 回到下一次模型请求 | 通过；模型调用 `read(file_path)` 并收到 fixture 原文 | `native-result.json`、`real-ui-result.json` |
| 文本/PNG 附件选择与传递 | 通过；上传 200，fixture 收到 image/file | 通过；两个上传 200，Session 保留 image ref，官方请求完成并确认收到 | `attachment-result.json`、`desktop-attachment-result.json`、`real-extra-result.json`；不把这宣称为任意文档解析或视觉准确率验证 |
| 会话/插件状态保存和重启 | Web Host 重启通过，同一 ID/内容/revision | 真实 Electron/Host 重启结果见 `real-resume-result.json` | `resume-ui-result.json`、`real-resume-result.json`；强制停止后恢复，不宣称优雅退出 |
| 独立 home/profile/userData/默认工作区 | 通过；均在 `.desktop-build/a02/<run>/` | 同样隔离；真实 Key 仅环境注入 | 各 `*-result.json`、`verification.json` |
| 模型设置入口 | 源码与真实 GUI 确认 | 显示已检测到 `DEEPSEEK_API_KEY` 环境变量，不读取表单值 | `desktop-settings-result.json`、`desktop-model-settings.png` |
| 凭据保护 | 已用 synthetic ref 实测原生落盘明文，移除成功 | 官方新 profile 不落盘真实 Key，最终扫描 | `credentials-result.json`、`verification.json`；B01/R01 须补正式保护/仅会话政策 |
| Schedule | 真实服务 CRUD 通过，无投递 | 不提交模型唤醒 | `interfaces-result.json`；F03 补可靠性 |
| 通知/睡眠/退出/在线快照 | 仅源码接口调查，缺口明确 | 未验收 | `extension-map.md`；H01/H03/F03 接手 |
| 上游构建检查 | `build:check` 两个 gate 通过，退出 0 | 工件沿用 A01 的完整构建；未改上游源码 | `build-check.log` |

## 失败与修正

- `first-host-schema-failure.log` / `first-ui-result.json`：探针误用根级 JSON Schema `required`，Host 插件未激活、页面路由 404。改成 DSH 属性级 `required:true` 后重新验证通过，未修改上游工具实现。
- `second-ui-sandbox-result.json`：默认工作区隐含使用用户 Documents，Agent 在沙箱内 realpath 失败。显式设置 `workspace-controller.documentsDirectory` 到 A02 run 后通过。
- `first-native-assertion-result.json`：初期探针错误地在终端最终 prose 中寻找工具原文；后改为检查下一次真实模型请求中的工具结果。随后确认原生读参数是 `file_path`，修正探针并重跑通过。
- `first-attachment-result.json`：在文件选择后 `.fill()` 编辑器破坏了附件 decorator；改为先填文本再选择合成文件后通过。最终使用浏览器生成的合法微型 PNG。
- `desktop-sandbox-failure.log`：Electron 安装目录的 AppContainer ACL 与沙箱 token 不兼容。未改 ACL、未禁沙箱；在宿主环境运行相同桌面命令后通过。
- `first-desktop-cancel-result.json`：测试点击被用户打开的模型设置遮罩挡住；该轮流最终完成，不能当取消成功。最终官方取消有独立通过证据 `real-extra-result.json`。
- `first-real-resume-assertion-result.json`：初期恢复测试错误地假定 GUI 会话恰好只有脚本的三个回合，实际保存四个。最终验证明确检查三个测试回合的完成/取消/完成顺序，并保留额外回合。随后按真实 wire 类型从 `projections.values.title` 读标题，修正探针后重启读取与 UI 还原通过；没有为修正断言重发付费模型请求。
- Browser 扩展的 `tab.goto` 两次报 `Cannot read properties of undefined (reading 'timeoutMs')`，标签未导航；已关闭测试标签。后续使用仓库已有 Playwright/真实 Electron 测试设施，没有将扩展失败冒报为产品失败。

核心真实路径的最终结果以 JSON 报告为准。Schedule CRUD、模拟模型、截图、旧 A01 结果均不替代官方模型或桌面端验收。
