# T03：双主栏布局探针

仅用于回答"学习工作台能否与对话并列"以及"哪条路线成本最低"，不是正式 StudyBuddy 插件，不进入运行包。结论与选定方案见 [`docs/decisions/layout.md`](../../docs/decisions/layout.md)。

## 文件

- `package.json`、`index.mjs`、`client.js`：最小 DSH 插件行 + 手写 `window.__ModuleLoader__` 客户端 bundle。`client.js` 注册：
  - 路线 1：`ctx.sidebarRightTabs` 的 `layoutprobe` 类型，正文注册到 `sidebar.right.pane.tab`；
  - 路线 2：检测到 `ctx.workbench`（dock-base）时，注册活动栏项、侧栏面板、编辑器视图与悬浮视图。
- `run-route1.mjs`：隔离 Web profile + 上游 mock 模型，1440×900 实测宽右栏的宽度上限、无会话可用性、重启恢复与双区可操作性。
- `run-route2.mjs`：在隔离 `web` profile 安装 `dock-base`，实测与原生聊天并存、四边停靠、悬浮窗、编辑器区可见性、刷新恢复。
- `estimate-route3.mjs`：只读读取固定源码树的 `ui-layout` 文件，生成第二主栏补丁的行数估算（不写 DSH 源码）。
- `evidence/`：两个实测报告、路线 3 估算与截图（运行后生成，已提交为 T03 证据）。

## 运行

```powershell
# 路线 1（约 40 秒）
node probes/layout/run-route1.mjs

# 路线 2（首次需从 npm 安装 dock-base，约 1 分钟）
node probes/layout/run-route2.mjs
```

两个脚本都会：

- 在系统临时目录创建隔离 `DSH_HOME`，不读写 `.studybuddy/` 或桌面的真实 profile；
- 从固定源码树启动真实 DSH Web 宿主，并使用上游 `llm-mock-server`，不需要 API Key；
- 用 Edge（Playwright `channel: msedge`）以 1440×900 驱动真实页面并截图；
- 结束时杀掉自己启动的宿主进程树并删除临时目录（报告与截图保留在 `probes/layout/evidence/`）。

沙箱内 `spawn` 可能被拒绝（EPERM）；对同一条命令申请一次宿主权限即可。实测在宿主权限下通过。

## 边界

- 路线 1 的学习区内容是假数据（任务、进度、计时占位），只验证布局与交互，不代表 T05 的实现。
- 路线 2 的 `dock-base@0.2.4` 只安装在临时 profile；它不是发布依赖，也没有写入仓库配置。
- 路线 3 只做只读评估（`AppFrame` 第二主栏槽的成本），没有修改 `source/deepseek-harness`。
