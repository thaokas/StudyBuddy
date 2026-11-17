# StudyBuddy

> 本地优先的 Windows 桌面备考助手：把「备考目标 → 学习计划 → 每天几点做 → 完成记录 → 周月复盘」串成一条闭环，并叠加答疑、学习记忆与画像、外观主题和桌面宠物。

StudyBuddy 以 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）为宿主，固定 `0.2.2-rc.1` 源码（commit `fcc0ad4`）并维护两枚小补丁；学习能力来自项目自带的 8 个 `study-*` 插件。学习数据保存在本机单个 SQLite 文件里，不依赖云服务，也不需要账号。

- 文档入口：[`docs/README.md`](docs/README.md)
- 操作手册：[`docs/manual/operation-manual.md`](docs/manual/operation-manual.md)
- 从零搭建开发环境：[`docs/development.md`](docs/development.md)
- 当前状态与剩余工作：[`docs/roadmap.md`](docs/roadmap.md)

## 功能

| 能力 | 说明 |
| --- | --- |
| 创建学习计划 | 目标、材料、计划需求三步引导；可让助手在对话里分项目、排日期，也可手写草案兜底 |
| 计划管理 | 项目 / 任务 / 日期的计划结构，草案确认、修订、撤销、容量与缺失信息检查 |
| 工作台 | 今日与本周任务、时间块拖拽、重叠确认、进度记录、完成率三口径（原计划 / 调整后 / 取消） |
| 番茄钟 | 学习 / 休息计时、关联任务、暂停继续、重启恢复、完成通知 |
| 提醒与晚间复盘 | 到点提醒、快捷答复、静默时段、专注延后、把没做完的任务顺延成草案 |
| 成果与分析 | 日 / 周 / 月成果、材料推进、规则版周报月报、弱主题与方法信号 |
| 良师益友 | 把当前任务、材料和正式计划注入答疑上下文；自动沉淀问答单元，可合并 / 拆分 / 筛选 |
| 记忆与画像 | 偏好、短期状态、待确认观察三类记忆；按问题相关性注入；纠错保留历史；六项讲解参数 |
| 外观与小搭 | 6 套「侧边栏 / 画布 / 顶栏」成套配色（浅绿 ×3 / 深蓝 ×3）；桌面宠物「小搭」可拖动、回话、陪读 |
| 创造模式 | 让 Agent 生成并安装可长期使用的页面 / 小工具，支持撤销与恢复 |
| 数据与备份 | 单文件 SQLite（WAL）、DPAPI 加密凭据、冷备份 / 校验 / 恢复、JSON 导出 |

## 架构一览

```text
Electron 桌面壳
└─ DeepSeek Harness Host（固定 fcc0ad4 + patches/0001、0002）
   ├─ 宿主策略
   │  ├─ workspace-controller     工作区目录
   │  └─ project-credentials      Windows DPAPI 凭据
   ├─ 业务插件（按依赖顺序加载）
   │  ├─ study-core               数据库、kernel、路由、客户端公共服务
   │  ├─ study-facts              目标 / 材料 / 任务 / 时间块 / 计划 / 计时 / 计划创建
   │  ├─ study-learning           答疑上下文、问答单元、学习分析
   │  ├─ study-reminders          提醒、晚间复盘、完成通知
   │  ├─ study-memory             学习记忆与画像
   │  └─ study-outcomes           成果统计、里程碑反馈
   ├─ 表现插件（client-only）
   │  ├─ study-appearance         配色组、品牌槽位
   │  └─ study-pet                小搭桌宠
   └─ 数据：.studybuddy/study/study.db（SQLite STRICT + WAL）
             ├─ revision / change_log / request_log / day_snapshot
             ├─ 43 张基础表 + 1 张 FTS5 + 5 张影子表
             └─ 凭据：.studybuddy/home/credentials.dpapi（DPAPI CurrentUser）
```

插件之间的数据边界、命名空间、HTTP 路由、Agent 工具与读写契约见 [`docs/contracts.md`](docs/contracts.md)；设计取舍见 [`docs/architecture.md`](docs/architecture.md) 与 [`docs/decisions/`](docs/decisions/)。

## 快速开始

### 前置条件

| 项 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11 x64（依赖 Windows DPAPI 与 Electron） |
| Node.js | `>= 24.9`（本项目实测 v24.17 / v26.13） |
| pnpm | 11.x（与固定 DSH 源码的 `packageManager` 对齐） |
| Git | 用于获取宿主源码与补丁 |

### 1. 获取并构建宿主

仓库不包含 `source/deepseek-harness`（约 3GB，`.gitignore` 已排除），需要按固定版本单独拉取。完整说明与注意事项见 [`docs/development.md`](docs/development.md)。

```powershell
git clone https://github.com/thaokas/StudyBuddy.git
cd StudyBuddy

git clone --no-checkout https://github.com/deepseek-ai/deepseek-harness.git source/deepseek-harness
git -C source/deepseek-harness checkout fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159
git -C source/deepseek-harness apply "$PWD/patches/0001-desktop-account-toggle.patch"
git -C source/deepseek-harness apply "$PWD/patches/0002-second-main-column.patch"

cd source/deepseek-harness
pnpm install --frozen-lockfile
pnpm run build
pnpm --filter @deepseek-ai/dsh-desktop exec install-electron
cd ../..
```

### 2. 启动

```powershell
.\start-studybuddy.cmd
```

启动器会创建独立的 DSH profile（数据隔离在 `.studybuddy/` 下）、预置自定义模型提供商，然后启动 Electron。也可以直接执行 `node scripts/start-studybuddy.mjs`；加 `--prepare-only` 只初始化配置，不启动应用。

首次启动后进入「设置 → 模型」，在预置的 `StudyBuddy DeepSeek` 提供商里填入 DeepSeek API Key 即可对话。Key 由 Windows DPAPI 加密保存，模型配置只保存凭据引用，不保存明文。

### 3. 常用环境变量

| 变量 | 用途 |
| --- | --- |
| `STUDYBUDDY_DATA_DIR` | 覆盖数据根（默认 `<项目根目录>/.studybuddy`），便于用隔离数据根试用 |
| `STUDYBUDDY_IMPORT_CREDENTIALS` | 首次启动时从指定 DSH 凭据文件导入一次 `DEEPSEEK_API_KEY`，只导入一次 |

## 数据与备份

所有学习数据都在 `.studybuddy/` 中（`.gitignore` 已排除，不会进仓库）：

| 路径 | 用途 |
| --- | --- |
| `study/study.db` | 学习数据库（SQLite，WAL） |
| `study/memory.json` | 早期记忆文件（已迁移到 SQLite） |
| `home/credentials.dpapi` | DPAPI 加密的 API Key 与凭据引用记录 |
| `home/profiles/desktop/` | DSH profile（模型设置等） |
| `workspace/`、`electron-user-data/`、`logs/` | 工作区、Electron 数据与日志 |

冷备份、校验、恢复与 JSON 导出见 [`docs/backup.md`](docs/backup.md)。

## 使用手册

- 完整操作手册（界面、流程、排错、二次开发）：[`docs/manual/operation-manual.md`](docs/manual/operation-manual.md)
- 创造模式与模式切换：[`docs/creator.md`](docs/creator.md)
- 备份、恢复与数据导出：[`docs/backup.md`](docs/backup.md)
- 产品设计语义（最高权威）：[`docs/specs/`](docs/specs/)
- 界面设计规范：[`docs/design/`](docs/design/)

## 开发

```powershell
# 工程单元测试（不需要宿主源码构建产物之外的依赖）
node --test tests/project/config.test.mjs tests/project/credentials.test.mjs tests/project/import-errors.test.mjs

# 插件全量单元测试（当前基线 955 项：954 通过 / 1 预期跳过 / 0 失败）
$cases = Get-ChildItem plugins -Recurse -Filter *.test.mjs | ForEach-Object FullName
node --test --test-isolation=none @cases

# 重建所有插件的客户端 bundle
Get-ChildItem plugins -Directory | ForEach-Object {
  node "plugins/$($_.Name)/scripts/build-client.mjs"
}
```

真实 Host + headless Edge 的冒烟脚本、Creator 测试与开发约定见 [`docs/development.md`](docs/development.md)；测试/证据写入各插件的 `tests/**/evidence/`，该目录不入库。

### 仓库结构

```text
StudyBuddy/
├─ start-studybuddy.cmd / .ps1     # 日常启动入口
├─ scripts/                        # 启动器、profile 策略、备份脚本
├─ plugins/                        # 8 个 study-* 插件（host + client + tests）
├─ packages/                       # study-model / study-contracts / study-messages / study-client
├─ platform/windows-credentials/   # DPAPI 凭据插件
├─ patches/                        # 对固定 DSH 源码的两枚补丁与升级说明
├─ skills/study-creator/           # Creator 参考技能
├─ tests/                          # 工程测试、Creator 测试、测试支持
├─ assets/logo1.png                # 品牌形象源图（插件内联副本）
├─ docs/                           # 文档入口：docs/README.md
├─ source/                         # 本地 DSH 源码（.gitignore，按 docs/development.md 获取）
└─ .studybuddy/                    # 本地数据根（.gitignore）
```

## 当前状态

- 学习闭环与周边能力已实现：v1 任务 T00–T17、T20 完成，2026-11-15 完成 SB-09–SB-16、SB-18 功能修复卡核销；插件拆分 P0–P6 已落地。
- 尚未完成：P7 `@studybuddy/bundle` 组合包与启动器清理、T18 发布候选包、T19 十四场景验收。详见 [`docs/roadmap.md`](docs/roadmap.md)。
- 这是一个**开发版运行态**：没有安装包、自动更新、云同步或账号体系；升级与迁移需要手动处理。

## 已知边界

- 不内置模型与 Key；对话质量取决于你在「设置 → 模型」中配置的提供商。
- 提醒只在应用运行时生效，关闭期间错过的提醒不补发；系统通知受 Windows 通知设置影响，应用内横幅是兜底。
- 创造模式安装的是普通 DSH 插件，**不是沙箱**；只承诺可撤销、可移除，不承诺受限执行或代码审计。
- 学习分析由本地确定性规则生成，不使用能力 / 智商 / 心理诊断类结论；建议需要学生确认后才变成任务。
- 目前仅支持 Windows：凭据使用 DPAPI `CurrentUser`，桌面壳依赖 Electron。

## 许可

本项目采用 [Apache License 2.0](LICENSE)，版权声明见 [`LICENSE`](LICENSE)。

宿主 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 为独立仓库，按其自身许可使用；`patches/` 中的改动以补丁形式维护，便于升级与回退。
