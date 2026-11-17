# StudyBuddy 路线图（剩余工作）

- 状态：截至 2026-11-17。插件拆分 **P1–P6 已落地**，记忆系统四轮、外观与桌宠已开发完成；本文只列**尚未完成或明确留到后续**的事项，状态只用“未开始 / 后续”，不把计划当交付。
- 已完成工作的文档（计划、任务卡、状态、证据）已从 docs 归档删除，可从 git 历史取回；现行结构见 [architecture.md](architecture.md)，冻结契约见 [contracts.md](contracts.md)。
- 顺序建议：先 P7（组合与启动器收敛），再做 T18 发布候选包，最后跑 T19 十四场景验收；三项之间没有硬依赖，但 T18/T19 应以 P7 的最终组合行为为准。

## 1. P7：组合包与启动器清理（未开始）

目标：产品组合从“启动器逐行写插件绝对路径”变成“profile 里选 `@studybuddy/bundle`”。

- **`@studybuddy/bundle`**：新建 `packages/study-bundle`，只含 `cordis.patch.yml` 组合层；声明 8 个 study 行、`project-credentials`、账号 / 遥测禁用行、`workspace-controller`；不含 `a02-probe`。profile 的 `dsh.profile.bundles` 追加该 bundle。
- **启动器去绝对路径**：`scripts/project-config.mjs` 不再生成插件源码绝对路径行，只确保 profile 选中 bundle、首次写入模型配置、复制 Creator skill；开发期如必须用 `--patch` overlay，该 overlay 不进入产品定义。
- **移除 `a02-probe`**：启动器已不再插入该行，开发探针 `probes/` 也已从仓库删除；但已有数据根 profile 仍可能残留该行，P7 迁移时清理。
- **旧数据根迁移**：检测旧 `home/cordis.patch.yml` 中由启动器管理的行（旧 `study` shell、`a02-probe`、账号 / 遥测禁用），先备份再替换为最小用户覆盖；用户手动改过的行不静默删除，输出差异并要求确认。
- **验收**：新数据根与已有数据根都能启动；8 个插件与 9 个页面齐全；可选插件关闭矩阵仍通过；模型 / 凭据 / 工作区 / Creator skill 行为不变；导出与冷备份仍覆盖全部数据。

## 2. T18：发布候选包（未开始）

- 交付一个**能运行的候选**，不承诺安装器、更新源、签名或商店分发；安装器 / 更新 / 签名另立发行计划。
- 运行说明覆盖：获取固定 DSH 源码（`fcc0ad4` + 三枚补丁）、依赖安装与构建、Electron 运行时准备、数据根与首次模型 / 凭据配置、日常启动、备份与恢复。
- 不修改业务插件逻辑，不改变模型默认值或用户已有配置。

## 3. T19：十四场景验收（未开始）

- 用产品设计中的 14 个场景逐项验收，每场景产出证据（脚本 / 截图 / 日志）与“通过 / 未覆盖 + 原因”的结论。
- 尚缺的真实链路：真实付费模型端到端、鼠标拖放的真实浏览器点击级自动化、导出设置页点击级验证；现有单元 / 冒烟测试不能替代这轮验收。
- 验收对象是 P7 之后的最终组合，而不是当前开发期 profile。

## 4. 已知低风险待修项（后续）

以下问题已登记，不阻塞上一轮功能核销，留后续修复：

| 项 | 现状 |
| --- | --- |
| 记忆迁移失败只读降级时的导出回退 | 迁移失败进入只读降级时，导出仍优先读空的 SQLite 记忆表，未回退到 `memory.json` |
| 计划页拖块缺少 `expectedRevision` | 页面拖块写入未带读到的修订号，冲突只能由后续请求暴露 |
| `legacy requestId` 写成 `sourceRef.messageId` | 旧路径把消息 id 当 requestId 语义使用，口径不纯 |
| 墓碑全表扫描 | `forget` 的同内容抑制检查走全表扫描，语录规模变大后需要索引 / 哈希查询优化 |
| 个人里程碑可绑 retired 任务 | `milestones.savePersonal` 的关联校验未排除已退休任务 |

## 5. 外观 / 桌宠后续（后续）

- **桌宠姿态动画**：8 个状态目前共用一张静图、没有专属摆姿；后续补状态动画 / 表情层（仍保持 CSS-only、可访问性降级与离线自包含）。
- **外观扩展**：现有 6 套配色组已定稿并通过对比度验收；新增配色组、字体或品牌位属于按需扩展，不改变“只叠加 token、不换主题”的约束。
- 两项都保持 client-only，不进入 host DAG，不影响学习数据与工具。

## 6. 产品设计明确未实现项

这些是设计稿里有、当前实现没有的能力，明确标注“未开始 / 后续”，不写成已完成：

| 项 | 现状与边界 |
| --- | --- |
| 提醒语气开关（未开始） | 设计提出学生可调“互动语气”；当前 `followup` 设置只有 `enabled / quietStart / quietEnd / reviewAt / reviewEnabled / snoozeMinutes`，文案是固定字典 |
| `session_tolerance` 画像参数（未开始） | 记忆设计列 7 项画像参数；实现只有 6 项，`session_tolerance` 未实现 |
| 其余画像自动推断（后续） | 只有 `explain_detail` 自动推断；`hint_preference / pace / example_first / step_granularity / check_frequency` 仅支持显式 `profileSet` |
| PDF 导入入口（未开始） | `materials.importFile` 服务已支持 PDF 文本层解析（无文本层报 `pdf_no_text_layer`），但页面没有上传入口，当前只能经 Agent 工具导入 |
| 生成插件沙箱（后续） | 创造模式生成的是普通 DSH 插件，与产品同权限；只承诺可撤销 / 可恢复，不是安全隔离，也不做版本历史 |
| 版本历史（未开始） | 生成插件支持撤销 / 恢复，源码保留，但没有版本列表、回滚或差异视图 |

## 7. 不在本路线图内

- 安装器、自动更新、代码签名、商店分发 —— 另立发行计划。
- DSH 源码升级与补丁重放 —— 随发行准备单独评估，不混入业务插件改动。
- 新增第二个学习业务后端 / 多用户 / 云同步 —— 当前架构明确不做，详见 [decisions/plugin-split.md](decisions/plugin-split.md)。
