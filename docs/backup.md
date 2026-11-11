# StudyBuddy 备份、恢复与数据导出

> 适用版本：v1（T17）。只做**冷备份**，不做热备份、自动更新或云同步。
> 数据根默认是项目下的 `.studybuddy/`（已被 `.gitignore` 忽略）；启动器也接受 `STUDYBUDDY_DATA_DIR` 覆盖。

## 1. 数据在哪里

| 位置 | 内容 | 冷备份 | JSON 导出 |
| --- | --- | --- | --- |
| `study/study.db`、`study.db-wal`、`study.db-shm` | 学习数据库（目标、资料、任务、计划、进度、成果、历史） | 复制 | 读表后写入 JSON |
| `study/memory.json` | 学习记忆（偏好、短期状态、观察、删除标记） | 复制 | 写入 JSON |
| `study/exports/` | 应用内导出的 JSON 文件 | 复制 | — |
| `home/` | DSH profile、模型设置、`credentials.dpapi` | 复制 | **排除** |
| `workspace/`、`agents/` | 工作区文件与 Agent 数据 | 复制 | **排除** |
| `logs/`、`electron-user-data/` | 日志与 Electron 配置/缓存 | 复制 | **排除** |
| `launch.json` | 启动器每次启动重写的运行元数据 | **不复制** | **排除** |

冷备份是整份数据根的字节副本，所以也包含 DPAPI 加密的 `home/credentials.dpapi`；它只能用创建它的 Windows 用户解密。备份目录要像原数据一样保管，不要放进数据根（脚本会拒绝）。

## 2. 先关闭应用

1. 关闭 StudyBuddy 窗口，等启动器终端退出。
2. 确认没有残留进程：

```powershell
Get-Process electron -ErrorAction SilentlyContinue
```

脚本自己也会检查：`launch.json` 里的启动器 pid，以及命令行带 `--user-data-dir=<数据根>/electron-user-data` 的 Electron 进程。只要在运行，脚本就拒绝备份（退出码 3），因为复制到一半的 WAL 可能不一致。

## 3. 冷备份

在项目根目录执行：

```powershell
node scripts/backup-studybuddy.mjs
```

默认备份到 `%USERPROFILE%\StudyBuddy Backups`。换一个磁盘或目录：

```powershell
node scripts/backup-studybuddy.mjs --out "E:\StudyBuddy Backups"
```

指定另一个数据根（例如测试或便携目录）：

```powershell
node scripts/backup-studybuddy.mjs --data-dir "D:\StudyBuddyData" --out "E:\StudyBuddy Backups"
```

成功时退出码 0，并输出 JSON 摘要（`backupDir`、文件数、字节数、`study.revision`、完整性检查结果）。目录结构：

```text
studybuddy-backup-20261110-175324/
  data/                 # 数据根副本（不含 launch.json）
  manifest.json         # 时间、来源、进程检查、每个文件的 SHA-256、数据库计数
  checksums.sha256      # <sha256>  <相对路径>
```

脚本流程：检查进程 → 记录源文件快照与哈希 → 复制 → **再次检查源快照和进程** → 比较源/副本哈希 → 在临时目录打开数据库副本做 `integrity_check` / `quick_check` → 写清单与校验文件。复制期间源数据一变就丢弃这份备份（退出码 5）。

退出码：

| 退出码 | 含义 | 处理 |
| --- | --- | --- |
| 0 | 成功 | — |
| 2 | 参数或数据根不合法 | 按提示改 `--data-dir` / `--out` |
| 3 | 检测到应用仍在运行 | 关闭应用后重试 |
| 4 | 备份校验或数据库完整性失败 | 不要使用这份备份，换一份或重做 |
| 5 | 复制期间源数据发生变化 | 关闭应用后重做 |

## 4. 校验已有备份

```powershell
node scripts/backup-studybuddy.mjs --verify "C:\Users\<你>\StudyBuddy Backups\studybuddy-backup-20261110-175324"
```

校验内容：清单格式、文件集合（缺文件或多文件都报错）、每个文件的大小与 SHA-256、`checksums.sha256` 与清单一致、SQLite `integrity_check`/`quick_check`、数据库修订号与各表行数等于清单记录。内容不一致时退出码 4，`errors` 列出具体文件或字段；清单本身无法读取或格式不支持时退出码 2；校验不修改备份。

## 5. 恢复

先关闭应用，再执行：

```powershell
node scripts/backup-studybuddy.mjs --restore "C:\Users\<你>\StudyBuddy Backups\studybuddy-backup-20261110-175324" --to "D:\Data\ProjectsRepo\StudyBuddy\.studybuddy"
```

`--to` 省略时恢复到默认数据根。目标目录非空时必须显式加 `--force`：

```powershell
node scripts/backup-studybuddy.mjs --restore "<备份目录>" --to "D:\Data\ProjectsRepo\StudyBuddy\.studybuddy" --force
```

- 脚本**先校验备份**，校验不通过就拒绝恢复。
- 目标非空且没有 `--force`：返回 `target_not_empty`，不改动任何文件。
- 有 `--force`：先把现有数据根改名为 `<数据根>.pre-restore-<时间>`，再复制备份的 `data/`；复制后重新比对全部文件哈希并检查数据库。
- 恢复后核对失败时：删除刚复制的目标，把 `.pre-restore-*` 改回原名，并报错。
- 不会恢复 `launch.json`；下次启动时启动器会重新生成。

恢复后核对：

1. 启动应用，让 Agent 调用 `study_status`，确认 `revision` 等于 `manifest.json` 的 `study.revision`，且 `database.file` 指向当前数据根。
2. 打开工作台：任务、时间块、今日/周视图应与备份前一致。
3. 打开计划页：计划修订号、已确认计划与进度历史应一致。
4. 打开记忆页：偏好、短期状态和删除标记应一致。
5. 如果对不上，先停应用；保留 `.pre-restore-*`，不要覆盖，必要时用另一份备份重试。

v1 没有升级/迁移器；备份要用**创建它的同一版本程序**恢复。数据库 schema 不兼容时插件会拒绝启动并提示先备份，见 `plugins/study/host/db.mjs` 的 `recoveryGuidance`。

## 6. 应用内导出学习数据 JSON

两个入口：

- **Agent 工具**：在聊天里说“导出学习数据”，模型会调用 `study_export`。文件写到 `<数据根>/study/exports/studybuddy-export-YYYYMMDD-HHmmss.json`，工具结果给出路径、字节数、修订号和摘要。
- **应用鉴权路由**：登录后的应用原点可以 `GET /api/study/export.json`，返回同一份 JSON 附件（`Content-Disposition: attachment`）。路由注册在 `plugins/study/host/modules/export.mjs`，与 `POST /api/study/<ns>/<method>` 一样只对已鉴权的 owner 开放。

v1 没有单独的“导出”界面按钮；上面两个入口是真实可用的，未在界面上放假按钮。T18/T19 若要加入口，应直接复用这个 JSON。

导出内容：

| 字段 | 含义 |
| --- | --- |
| `source` | 产品名、数据库文件名、核心 schema 版本、已加载模块版本 |
| `revision` | 导出时的全局学习数据修订号 |
| `summary` | 各表行数 |
| `data.goals` / `data.materials` / `data.materialChunks` | 目标、资料、带页码/章节定位的片段 |
| `data.tasks` / `data.timeBlocks` | 任务与时间块（含软删除标记和固定课程） |
| `data.plans` / `data.planRevisions` / `data.planDrafts` | 计划头、已应用修订快照、未确认草案 |
| `data.progress` | 计划进度（只追加的历史） |
| `data.outcomes` | 成果；当前 v1 还没有成果模块，固定为空数组 |
| `data.otherTables` | 后续模块新增的 `study_*` 表；`study_outcome` 会自动并入 `outcomes` |
| `data.memory` | 记忆条目与删除标记（只含 hash，不含被删正文） |
| `data.changeLog` | 追加式变更历史 |
| `checksum` | 对 `formatVersion + revision + data` 的 SHA-256 |

排除项：`credentials`、`request_log`、`logs`、`electron-user-data`、资料 FTS 索引（可由片段重建）。导出只读 `study.db` 与 `memory.json`，不打开凭据文件；此外会检查对象键（`apiKey`、`password`、`token` 等）和高置信 token 形状（`sk-…`、`ghp_…`、`Bearer …`、私钥头），一旦命中就**拒绝导出**并指出字段路径，不会写出带凭据的包。若学习资料里确实有这类字符串，先删除或改写那段内容再导出。

`data.outcomes` 为空时，`availability.outcomes.reason` 是 `outcomes_module_not_available_in_this_build`，不伪造“全部完成”或空的成果统计；T13 落地后按 `study_outcome*` 表自动进入导出。

`request_log` 保留策略（T17 决定）：它是 `requestId` 幂等重放缓存，不是学生学习数据。v1 **不自动清理**，冷备份完整保留；JSON 导出排除它。理由：清理会让旧 `requestId` 在重启后被当成新请求，重复写入的风险高于这点磁盘占用。

## 7. 演练记录（2026-11-10）

本机上下文：Windows 10.0.26200 x64，Node v26.13.0，StudyBuddy 数据根 `D:\Data\ProjectsRepo\StudyBuddy\.studybuddy`。演练时桌面应用正在运行（`electron.exe` 11744，启动器 pid 27556/26276），所以对真实数据根的备份被脚本按设计拒绝；非空数据的完整核对在隔离演练根里完成。

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `node scripts/backup-studybuddy.mjs --drill` | `ok: true`，26 项检查全通过：拒绝运行中应用；备份/校验/恢复；篡改后的备份被 SHA-256 拒绝；导出覆盖目标/资料/任务/计划/修订/进度/记忆；任务↔时间块、计划↔目标、片段↔资料、进度↔计划修订快照交叉核对；疑似凭据文本被拒绝导出且不回显；`study_export` 工具与 `/api/study/export.json` 都返回不含凭据和 `request_log` 的 JSON |
| 2 | `node scripts/backup-studybuddy.mjs --out <临时目录>`（对真实数据根） | 退出 3：`app_running`，列出 launch.json 的两个 pid 与 `electron.exe`；未复制任何文件（进程检查生效） |
| 3 | 把真实数据根的 `study/`、`home/`、`workspace/` 复制到隔离目录，删除易变的 `launch.json`，再跑 `node scripts/backup-studybuddy.mjs --data-dir <隔离根> --out <临时目录>` | `ok: true`；17 个文件、376,538 字节；`study.revision=0`；`integrity_check`、`quick_check` 均为 `ok`；清单记录了 DPAPI 凭据文件（冷备份按原样保存） |
| 4 | `node scripts/backup-studybuddy.mjs --verify <备份目录>` | `ok: true`；文件哈希、校验文件、数据库计数全部一致，`errors: []` |
| 5 | `node scripts/backup-studybuddy.mjs --restore <备份目录> --to <空目录>` | `ok: true`；恢复 17 个文件、376,538 字节；`previousRootAside: null`；恢复后数据库完整、修订号 0 |
| 6 | 对恢复后的 `study.db` 调用 `buildStudyExport` | `format: studybuddy-export`，`revision: 0`，`summary` 各表 0（该数据根本来没有学习记录），`outcomes.available: false`，`checksum` 为 64 位 SHA-256 |
| 7 | `node plugins/study/tests/kernel/loader-smoke.mjs` | `passed: true`；真实 web profile 载入模块 `kernel, export, materials, memory, plans, tasks, timer`；鉴权路由 200、匿名 401 |
| 8 | `node --test --test-isolation=none plugins/study/tests` | 327/328；唯一失败是既有 T20 记忆快照用例：它用固定时钟创建 60 秒短期状态，但注入文本按真实时钟判断过期，测试在固定时间 09:00 之后运行必然失败。该用例不加载 `export` 模块，与 T17 无关 |

演练用的临时目录在 `%TEMP%\studybuddy-*`，可在确认不再需要后删除。

## 8. 已知限制

- 只做冷备份：应用运行时的复制不受支持，脚本会拒绝。
- 没有自动定时备份、云同步或升级器；备份目录不会加密，依赖磁盘/目录权限保护。
- 备份包含 DPAPI 凭据文件；跨 Windows 用户或换机器恢复时该文件无法解密，需要重新配置模型 Key。
- `launch.json` 有意不备份、不恢复；它只属于当前启动会话。
- JSON 导出不是可恢复镜像；完整恢复用冷备份。导出中的 `data.otherTables` 是后续模块表的兜底，`outcomes` 在 T13 前为空。
- 导出会拒绝疑似凭据的文本，可能误伤确实包含 `sk-…` 一类示例的资料；这是有意的安全取舍。
- 进程检查在 Windows 上依赖 PowerShell `Get-CimInstance`；不可用时会给出 warning，并依赖复制前后的源快照和哈希比较兜底。`launch.json` 里的 pid 若被系统复用给其它仍在运行的进程，可能误报（脚本会列出 pid；确认应用已关闭后把旧的 `launch.json` 移走即可）。
- `request_log` 在 v1 不自动清理；如果要控制体积，应在后续版本设计迁移/清理，不要手工删表。
- 应用内导出的 JSON 会留在 `study/exports/`，不会自动清理；需要时手动删除旧文件，它们也会进入下一次冷备份。
- `--drill` 会动态加载 `plugins/study/host/modules/export.mjs` 并读取源码树的 `defineTool`，因此需要仓库源码依赖，只用于开发和验收；学生日常使用备份、`--verify`、`--restore` 三个模式。
