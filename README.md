# StudyBuddy

基于 `source/deepseek-harness` 的开发环境。项目启动入口使用独立、持久化的 DSH 配置，保留原生模型设置与自定义提供商功能。

在项目目录运行：

```powershell
.\start-studybuddy.cmd
```

脚本优先使用本机 `D:\Applications\nvm\app\v26.13.0\node.exe`，不存在时使用 PATH 中的 Node。需要已安装并构建的源码依赖。也可直接运行 `node scripts/start-studybuddy.mjs`；追加 `--prepare-only` 只初始化配置，不启动应用或请求模型。本机 PowerShell 策略限制未签名脚本，因此推荐 `.cmd` 入口，无须修改执行策略。

在“设置 → 模型”中使用 DSH 原生界面新增、编辑、删除自定义提供商、模型及 API Key。首次初始化预置自定义提供商 `StudyBuddy DeepSeek`，模型为 `deepseek-flash`（显示名称 DeepSeek V4.1 Flash），走官方 `https://api.deepseek.com/anthropic` 接口。支持 Off、Low、High、Max 思考档位；首次默认 High，后续保留你在界面中的选择。官方模型列表未提供单独的 `1017` 模型 ID。

项目禁用 DeepSeek 账号登录、账号模型适配器和账号页面，保留自定义 API 模型功能。源码默认启动流程仍保留上游账号行为；使用此入口才会加载项目策略。

数据默认存放在被忽略的 `.studybuddy/`：

| 路径 | 用途 |
| --- | --- |
| `home/profiles/desktop/cordis.patch.yml` | 原生设置界面维护的模型与默认档位，重启不会重新写入首次配置 |
| `home/credentials.dpapi` | 使用当前 Windows 用户的 DPAPI 加密保存 API Key 和原生凭据记录 |
| `home/cordis.patch.yml` | 启动器管理的账号、存储与插件策略 |
| `workspace/`、`electron-user-data/` | 项目工作区与 Electron 数据 |

首次初始化可从 `STUDYBUDDY_IMPORT_CREDENTIALS` 指向的 DSH 凭据文件导入 `DEEPSEEK_API_KEY`。未指定时，仅使用 A02 证据指向的旧 GUI 凭据文件进行一次迁移；不会读取本机 `~/.dsh`。迁移完成后由项目的加密凭据服务保存与管理，删除 Key 后不会再次自动导入。模型配置文件仅保存凭据引用，不保存 Key 明文。加密文件需要原 Windows 用户解密。

此入口持续运行到退出应用，没有 A02 冒烟脚本的自动超时。学习功能已接入：创建计划、工作台、番茄钟、提醒与晚间复盘、计划、成果、问答记录、记忆与画像；完整操作见 [docs/manual/operation-manual.md](docs/manual/operation-manual.md)。旧 `probes/A02/run.mjs` 保持为隔离冒烟入口，不用于日常开发。

验证命令（不请求真实模型）：

```powershell
node --test tests/project/config.test.mjs tests/project/credentials.test.mjs tests/project/import-errors.test.mjs
node tests/project/desktop.test.mjs
```

第二条需要本入口启动的 Electron 正在运行，会临时新增、编辑并删除一个测试提供商。`--real` 会额外进行付费真实模型调用，仅在明确授权后使用。
