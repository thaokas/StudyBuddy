# Electron 44.7.0 桌面启动失败：定位记录

日期：2026-11-08 / 2026-11-09（北京时间）。环境：Windows 10.0.26200 / x64，Node 26.13.0，Electron 44.7.0（Chromium 152.0.7977.130）。

## 1. 现象

- `electron.exe` 以 GUI 方式启动时退出码 `2147483651 (0x80000003，STATUS_BREAKPOINT)`，另一次为 `-1073741819 (0xC0000005)`。
- 崩溃发生在应用 `main.js` 第一行之前：探针在 `main.js` 顶部写 trace 文件，崩溃时 trace 为空。
- 同一二进制以 Node 模式（`ELECTRON_RUN_AS_NODE=1`）运行正常。
- WER 记录：Application Error 1000，`electron.exe 44.7.0.0`，异常 `0xc0000005`，偏移 `0x7d0f25b`；归档目录需要管理员权限读取。

## 2. 排除项（均实测）

| 假设 | 实验 | 结果 |
| --- | --- | --- |
| 二进制损坏 / 镜像重打包 | 比对 npm 缓存 zip 与官方 `SHASUMS256.txt`：`EEE30DC8FA1F5EA95490E59F44E46EA68DD24C6E93D22FACF70FE5C2D4C2665C` | 一致；`electron.exe` SHA-256 `2529B494F4123F152BCE346051F7BD855EF95006424A561953CF17C49A3D1BA8` |
| 版本不兼容 | 同机运行打包应用 `DeepSeek Harness`（`version` 文件 44.7.0，主窗口句柄非 0） | 正常，说明该版本在本机可跑 GUI |
| Agent 沙箱 / Job 对象 / 继承环境 | 通过 Task Scheduler（干净环境、不在当前进程树）启动同一 exe | 仍 `0x80000003`，排除 |
| Smart App Control / 代码完整性拦截 | CodeIntegrity 事件日志中无 electron 拦截事件；Node 模式可运行 | 排除 |
| 工作目录 | `-WorkingDirectory` 设为 `C:\Windows`、`%TEMP%`、仓库根 | 不影响结果 |
| 文件 DACL（`Everyone DENY DC`、`CodexSandboxUsers`、未知 SID） | 把 `StudyBuddy` 的 DACL 复制到工作区外的副本目录 | 正常，排除 DACL |
| 路径字符串 / 盘符 | 用 junction 从工作区外指向工作区内副本 | 仍崩溃，说明跟随目标物理目录而非路径字符串 |

## 3. 定位

同一份字节（SHA-256 相同、文件清单相同）在不同目录的表现：

| 位置 | 完整性标签 | GUI 结果 |
| --- | --- | --- |
| `%TEMP%\a01-official-electron`（工作区外） | 无 | 0，窗口与 DOM 正常 |
| `D:\a01-el2`（D 盘根） | 无 | 0 |
| `D:\Data\a01-el6`、`D:\Data\ProjectsRepo\a01-el7` | 无 | 0 |
| `D:\Data\ProjectsRepo\a01-el10`（复制了工作区 DACL） | 无 | 0 |
| `D:\Data\ProjectsRepo\StudyBuddy\a01-el8` | `Low Mandatory Level (I)(NW)` | `0x80000003` |
| 原 `source/deepseek-harness/node_modules/.pnpm/electron@44.7.0.../dist` | `Low Mandatory Level (I)(NW)` | `0x80000003` |

工作区根 `D:\Data\ProjectsRepo\StudyBuddy` 自身的 ACL 就带有 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`，因此**树内新建/复制的文件都会继承低完整性标签**。工作区外的副本没有这个标签。

反向实验（把 Medium 副本改成 Low）无法完成：`icacls /setintegritylevel` 在该目录树内外都返回 `Access is denied`（需要 WRITE_OWNER / 提升权限），因此只能说"树内崩溃、树外正常"与标签完全相关，无法做单变量反向验证。

## 4. 结论

工作区目录树残留了早期低完整性沙箱工具设置的低完整性标签（ACL 中同时可见 `CodexSandboxUsers`），Electron 44.7.0 的 GUI 启动在这种标签下会失败；Node 模式、构建、Host 不受影响。这不是 Electron 版本、二进制损坏、操作系统或本机 GPU 的问题。

## 5. 处置

- **临时（A01 证据使用）**：`prepare-electron-runtime.ps1` 把同一份 dist 复制到 `%TEMP%\a01-electron-runtime` 并校验 SHA-256；`A01_ELECTRON_DIST` 让 `smoke-desktop.mjs` 设置 `ELECTRON_OVERRIDE_DIST_PATH`，版本仍是 44.7.0，未改锁文件。
- **根治（需要管理员/提升权限，本会话没有 UAC）**：在管理员 PowerShell 中把工作区树的完整性标签恢复为 Medium，例如：
  ```powershell
  icacls "D:\Data\ProjectsRepo\StudyBuddy" /setintegritylevel "(OI)(CI)M" /T /C
  ```
  然后重新 `pnpm install`（或只重跑 `install-electron`）以生成不带低完整性标签的 `node_modules`，此后不需要 `A01_ELECTRON_DIST`。执行前应确认没有其它工具依赖该低完整性设置。
- 在该标签被修复前，任何从工作区树内启动的 Electron GUI 都会失败，其它桌面工具也可能受影响；文档与命令不要把它当成"Electron 不兼容"。

## 6. 修复执行与验证（2026-11-09 19:05–19:11）

普通用户进程没有 `SeRelabelPrivilege`，`icacls /setintegritylevel` 会返回 `Access is denied`，因此通过 UAC 提权执行：

```powershell
# 1) 根目录恢复为可继承的 Medium 标签
icacls 'D:\Data\ProjectsRepo\StudyBuddy' /setintegritylevel '(OI)(CI)M' /Q
# 2) 关键子树逐层恢复（source、source\deepseek-harness、node_modules、node_modules\.pnpm、
#    electron@44.7.0_supports-color@9.4.0 及其 node_modules、electron/dist、apps\desktop\.desktop-build）
icacls '...\node_modules\.pnpm\electron@44.7.0_supports-color@9.4.0\node_modules\electron' /setintegritylevel '(OI)(CI)M' /T /C /Q
```

修复后的证据：

| 检查 | 结果 |
| --- | --- |
| 根目录标签 | `Mandatory Label\Medium Mandatory Level:(OI)(CI)(NW)`（NW 是 Medium 对象的默认策略） |
| `electron.exe` 标签 | `Medium (I)(NW)`（修复前为 `Low (I)(NW)`） |
| 仓库内 electron GUI 探针 | 退出 0，main → ready → 加载 DOM 全部完成 |
| `smoke-desktop.mjs`（无覆盖参数） | 退出 0，`passed: true`，`electronDistOverride: "none (node_modules dist)"`，截图更新 |

`icacls /T` 会跟随 pnpm 嵌套 `node_modules` 软链并输出大量"系统找不到指定的路径"错误（长路径/软链回环），这是噪声；关键路径已逐一核对为 Medium。若以后 `pnpm install` 或重建 checkout 后 GUI 再次崩溃，先检查 `electron.exe` 的标签是否又变回 Low。

## 7. 结论

桌面启动失败的根因是**工作区目录树残留的低完整性标签**（早期低完整性沙箱遗留），不是 Electron 版本、二进制、操作系统、GPU、agent 沙箱或 DACL。修复后 A01 不再需要任何 Electron 覆盖参数。
