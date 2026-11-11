# StudyBuddy Creator（创造模式）参考

本目录放 StudyBuddy 给 DSH 创造模式用的参考，以及创造流程的验证脚本。它不实现
创建卡片本身：卡片、生成、安装、撤销、恢复都由 DSH 的
`@deepseek-ai/dsh-personalized-recommendations` 组合包提供（见
`source/deepseek-harness/packages/experimental/creation-recommendations/`）。

## 文件

| 路径 | 作用 |
| --- | --- |
| `skills/study-creator/SKILL.md` | 模型可加载的 skill：位置、数据边界、卸载要求 |
| `skills/study-creator/references/locations.md` | 允许的页面位置、slot 注册、teardown |
| `skills/study-creator/references/data.md` | `ctx.study` / `/api/study` 示例、只读方法、写入与凭据边界 |
| `tests/creator.test.mjs` | 配置、skill、文档与参考的一致性单元测试 |
| `tests/profile-compose.mjs` | 加载 `prepareProfile` 写出的 isolated profile，核对三层 bundle、6 个 creator 行、skill 与标记 |
| `tests/creation-smoke.mjs` | 真实 Host + 浏览器：模式切换、生成、安装、重启、撤销、恢复、失败提示 |
| `evidence/` | 冒烟脚本生成的 JSON 与截图（证据，不是发布产物） |

## 启用方式

由 `scripts/project-config.mjs` 的 `prepareProfile` 完成三件事：

1. 首次启动时确保隔离 profile（`<数据根>/home/profiles/desktop/package.json`）的
   `dsh.profile.bundles` 含 `@deepseek-ai/dsh-personalized-recommendations`。
   该 bundle 自带 `action-cards`、`creation-recommendations`、对应的浏览器半边和
   plugin recommendations。已存在的其它 bundle 顺序不变。写入后留下
   `<数据根>/home/.studybuddy-creator-enabled` 标记；以后在插件页关闭它，启动器
   不会强行加回来。删除该标记可重新启用。
2. 把 `skills/study-creator` 复制到 `<数据根>/home/skills/study-creator`。那是
   DSH 的 user skill root，cordis（创造）预设与其它预设都会扫描到；Creator 子
   Agent 因此能读取 StudyBuddy 专用参考。
3. 每次启动重写 `<数据根>/home/cordis.patch.yml` 的部署策略（账号、遥测、学习插件
   与数据目录），这条不受创造 bundle 的开关影响。

## 模式与默认值

四个预设由 DSH 的 `@deepseek-ai/dsh-web-app` bundle 提供：`standard`、`ptc`、
`minimal`、`cordis`。`agent-preset-registry` 的默认值是 `standard`；创造模式
（UI 名「创造模式」，id `cordis`）必须由学生显式选择。切换只影响后续请求/新任务，
已经开始的会话保持启动时的预设。

## 已知限制

- 生成插件不是沙箱：它和 Creator 有相同权限。参考里只承诺“可移除”，不承诺受限执行。
- 创建卡片由 DSH 实验特性提供，模型是否提议仍取决于语义判断；日常模式不会主动生成
  卡片，但 `personalized-pages` skill 会出现在所有预设的技能目录里。
- Undo 只卸载已安装插件，不删除 `.dsh-created-plugins/<id>` 与 profile 的
  `created-plugins/<id>` 源文件；Restore 只重装保留下来的 profile 副本，没有版本历史。
- 只支持新建插件；修改已有插件仍走该插件自己的开发流程。
