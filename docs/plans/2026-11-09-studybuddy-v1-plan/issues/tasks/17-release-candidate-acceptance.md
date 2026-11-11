# SB-17 T18 候选包与 T19 十四场景验收

- 状态：TODO
- 优先级：P1
- 来源：T18、T19 尚未完成；issue 21 的候选包部分
- 依赖：SB-01–SB-13（至少核心闭环）
- 预计：1–2 个会话
- 所有权：`release/v1/**`、`tests/acceptance/**`、`scripts/start-studybuddy.mjs`、`scripts/project-config.mjs`、`docs/manual/**`、`STATUS.md`（结论行）
- 开工阅读：`tasks/T18-release-candidate.md`、`tasks/T19-acceptance.md`；`issues/2026-11-10-design-code-review.md#issue-21`；设计 §10、§11；`ACCEPTED-SCOPE.md` 第 3 条。

## 1. 问题

- T18、T19 仍是 TODO；当前只有开发启动方式，依赖本机 Node 路径和源码树。
- `start-studybuddy.ps1` 优先使用本机特定 Node 路径；启动器运行 `source` 的 `pnpm run start:desktop`。
- 没有版本锁定清单、干净目录启动证据、已支持/未提供清单、许可与来源、候选 ZIP/校验值。
- 没有按 14 个设计场景产出验收结论。
- 上游品牌/更新配置仍是 DeepSeek Harness；项目没有 StudyBuddy 更新通道（本轮不要求做安装器/自动更新，但候选包不能误接上游更新源）。

## 2. 当前证据

- `STATUS.md` T18/T19 为 TODO。
- `scripts/start-studybuddy.mjs` 调用 `source/node_modules/pnpm/bin/pnpm.mjs`。
- `start-studybuddy.ps1` 有机器特定 Node 路径。
- 没有 `release/v1/**` 或 `tests/acceptance/**` 产物。
- 静态确认见 issue 21。

## 3. 正确业务逻辑

### 3.1 T18 候选包（不做安装器）

1. 版本锁定清单：DSH 提交、插件版本、schema 版本、Node/Electron 版本。
2. 启动脚本/快捷方式：不硬编码本机 `D:\Applications\...` 路径；优先项目/随包 Node，失败时给可操作提示。
3. 干净目录解压可启动（本机环境）；不需要构建源码；如果仍需 Node，明确写“本机需 Node X”。
4. 不连接上游更新源；不启用 DeepSeek 账号/遥测；数据根隔离。
5. 已支持/未提供清单；许可与来源；数据位置与冷备份说明。
6. 候选 ZIP + SHA-256。
7. 移除开发探针 A02（如果仍在 daily profile）和测试凭据导入。

### 3.2 T19 验收

1. 按设计 §11.C 的 14 个场景逐条执行，记录通过/未覆盖+原因/失败。
2. 至少覆盖：首启目标/课程、7 天大量练习、拖拽后 Agent、换书、未勾选实际完成、部分完成无空闲、晚间重排并发、关闭/睡眠/断网、新会话记忆、纠正删除记忆、日周月成果、个人工具、无 Key、升级失败。
3. 升级失败可明确“未覆盖：本轮无升级器”，不伪报通过。
4. 回归：冷备份恢复、无 Key、重启、匿名 401。
5. 产出脚本/截图/日志和结论表；失败项修复或登记。

## 4. 修改范围

- 新建 `release/v1/`：清单、启动脚本、支持/未提供说明、许可/来源、ZIP/校验值。
- 修改启动器：移除机器绝对路径；不连接上游更新源；确保数据根隔离。
- 新建 `tests/acceptance/`：14 场景脚本/证据；必要时复用现有 smoke。
- 更新 `docs/manual/manual-start.md` 或新运行说明；更新 STATUS 结论行。

## 5. 验收标准

- [ ] 干净目录解压后按说明可启动；不依赖开发者本机特定路径。
- [ ] 版本清单与实际一致；无上游更新源；无 A02 探针/测试凭据导入。
- [ ] 无 Key 可本地操作；聊天明确等待配置。
- [ ] 14 场景全部有结论；未覆盖项写明原因（Creator 沙箱、自动记忆提取、安装升级等）。
- [ ] 冷备份/恢复演练通过；匿名路由 401。
- [ ] 候选 ZIP + SHA-256 可复核。

## 6. 不做

- 不做安装器、签名、自动更新、匹配版本回滚（ACCEPTED-SCOPE）。
- 不新增产品功能；本卡只打包/验收/登记。
- 不把未测平台写成已支持。

## 7. 完成后

1. 写 T18/T19 完成记录：命令、结果、未覆盖项、已知限制。
2. 更新 `STATUS.md` 和 `README.md` 状态表。
3. 将候选包路径/校验值交给用户复验。
