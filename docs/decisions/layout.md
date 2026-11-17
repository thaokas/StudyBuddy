# 布局决策：学习工作台与对话并列（T03）

- 日期：2026-11-10
- 状态：**已实施（T04，2026-11-10）**：路线 3 落在 `patches/0002-second-main-column.patch`，实际源码 +97/−7（≤100），0 个新 locale key；实施记录与实测见第 7 节。**2026-11-11 调整**：常驻学习栏不再注册，概览合并进工作台的“缩略”显示，见第 8 节。
- 历史决策记录：文中旧 shell 路径（`plugins/study/...`）已由 2026-11-11 插件拆分替代，现行代码路径见 [docs/architecture.md](../architecture.md)；`probes/layout` 探针与证据已随开发完成删除，结论保留在本记录，可从 git 历史取回。
- 结论：零补丁宽右栏能并列，但学习区在右、对话在左，且全局面板替换对话时学习区消失；第三方 dock 只是浮条 + 300px 浮层，无法承载工作台。目标"左学习、右对话"只能由最小 `AppFrame` 改动完成：在中央列内增加第二个主栏槽，源码新增约 60 行，在 PLAN 的 ≤100 行预算内。

## 1. 实测条件

| 项 | 值 |
| --- | --- |
| DSH | 固定源码 `source/deepseek-harness`，0.2.2-rc.1，基线 `fcc0ad4` |
| 平台 | Windows x64，Node 26.13，Edge（Playwright `channel: msedge`，headless） |
| 视口 | 1440×900（两个脚本都固定） |
| 模型 | 上游 `packages/test-support/llm-mock-server`，无 Key、无真实模型请求 |
| 隔离 | 临时 `DSH_HOME`，不触碰 `.studybuddy/` 和桌面 profile |
| 探针 | `probes/layout/`（手写客户端 bundle，假学习内容；2026-11-14 清理删除，保留本历史记录） |

证据：原 `probes/layout/evidence/route1/route1.json`、`probes/layout/evidence/route2/route2.json` 与同目录截图。**探针目录已随开发完成删除，结论保留在本记录；需要复跑时从 git 历史取回 `probes/layout/` 后运行 `node probes/layout/run-route1.mjs` / `run-route2.mjs`。**

## 2. 路线 1：零补丁宽右栏

### 2.1 接线

`client.js` 通过 `ctx.sidebarRightTabs.register({ id, kind: 'layoutprobe', title, keepMounted, guide })` 注册类型，再把正文注册到 keyed `sidebar.right.pane.tab`。用户在原生对话头部点右栏展开按钮，默认 guide 页出现"学习工作台（探针）"卡片，点卡片打开学习区。

### 2.2 1440×900 实测

| 场景 | 左导航 | 对话列 | 右栏（学习区） | 证据 |
| --- | --- | --- | --- | --- |
| 默认展开（45%） | 280 | 512 | 648 | `route1-opened.png` |
| 右栏拖到最宽 | 280 | 400 | **760** | `route1-widest.png` |
| 左导航收成 56px 轨道后拖到最宽 | 56 | 400 | **984** | `route1-widest-collapsed-sidebar.png` |
| 公式上限（70% 帧宽） | — | — | 1008，但被 `1440 − 280 − 400 = 760` 先卡住 | `route1.json` |

宽度结论：右栏上限由 `min(70% × 帧宽, 帧宽 − 左栏 − 400)` 决定。1440 下导航展开时最多 **760px**，收成轨道后 **984px**；对话列始终保留 400px。

无会话/全局面板：

- DSH 启动就选中一个空白"新会话"，右栏座位已存在但折叠。**发送第一条消息之前**就能展开右栏并打开学习区（`blankSessionStudy.messages = 0`，截图 `route1-blank-session-study.png`），所以"还没聊过天"不是问题。
- 打开"插件"这类全局面板替换对话时，右栏内容与学习区一起消失（截图 `route1-global-panel.png`，`studyVisible = false`，面板宽度 0）。界面里没有真正的"无 session"状态可测；右栏按 session id 存储，没有 session 就不会渲染。
- 刷新同一 profile：会话、右栏展开状态、学习区标签都恢复（`route1-reload.png`，`sessionRestored/panelRestored/tabRestored = true`）。

可操作性：学习区的复选框、"添加任务"、快速记录都生效；右栏占用时原生对话仍能发第二条消息（mock 请求 2 → 3），页面无未捕获异常。

### 2.3 判定

路线 1 满足"两个区域同时可见且可操作"，但**不满足 T04 的方向**：

1. 学习区固定在右栏，对话在中间列，得到"左对话、右学习"，与已确认的"左学习、右对话"相反；
2. 全局面板（插件、设置类页面）替换对话时，学习区跟着消失，不满足"无会话时学习区仍可用"；
3. 想把它翻到左边，仍然要动 `AppFrame`，零补丁没有别的放置点（左栏是 264–420px 的导航列，不能承载工作台）。

保留价值：作为核心补丁缺失时的运行时回退，以及窄窗口/移动端的单页入口。

## 3. 路线 2：第三方 dock（`ctx.workbench`）

### 3.1 安装

隔离 `web` profile 执行 `dsh plugin --profile web add dock-base`，退出 0，安装 `dock-base@0.2.4`；profile 的 `dsh.profile.bundles` 自动加入它，客户端 bundle 由 DSH 模块表载入。没有写入仓库配置或发布 profile。

### 3.2 实测

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 与原生聊天并存 | 是。dock 浮条在页面上，对话可继续发送（请求 2 → 3） | `route2-chat-and-dock.png` |
| 停靠 | 右键菜单可停靠左/右/上/下；左停靠后浮条在 `x=12` | `route2-dock-left.png` |
| 侧栏面板 | 302×574（300px + 边框），右停靠 `x=1054`，左停靠 `x=84..386` | `route2-side-panel.png`、`route2-dock-left-chat.png` |
| 悬浮窗 | 学习区可开成 520×360 独立浮窗，可拖动/缩放 | `route2-floating.png` |
| 编辑器区 | 打开编辑器视图后 `.dsh-wb-main` 的 `display: none`，视图 DOM 存在但不可见 | `route2-docked-editor.png` |
| 页面 reflow | **没有**。对话列始终 `x=280, width=1160`；dock 只移动右侧 turn navigator | `route2.json` |
| 刷新恢复 | 位置左、侧栏打开、悬浮窗 1 个都恢复 | `route2-reload.png` |

### 3.3 判定

`dock` 在 0.2.4 的 "dock mode" 是一个 macOS 风格浮条：约 50px 活动栏 + 最多 300px 浮动侧栏；编辑器区被 CSS 隐藏；不改变页面宽度。它能"并存"和"悬浮"，但**不能承载 700px 级学习工作台**，也不是"左学习、右对话"的分栏。并且它把第三方包、上游测试、profile 安装带进发布链，超出 T04 所有权与"唯一业务插件"的边界。否决。

## 4. 路线 3：最小核心补丁（选定）

### 4.1 方案：在中央列内加第二主栏

不新增第四个 grid 轨道，而是把现有 `centerCol` 改为横向 flex：`[学习主栏][对话主栏]`。这样：

- 左导航仍是 280px（可收 56px），学习区在中间偏左，对话在右；默认 1440 下约为 `[280][560][600]`；
- 右栏（原生文件/浏览器等）保持原语义：打开时先压缩中央列，中央列不够 400px 时学习栏自动隐藏，不抢对话的最小宽度；
- 学习槽是 root 作用域、`AppFrame` 直接渲染，**不依赖 session**：空白会话、全局面板、甚至没有 session 时都还在；
- 窄窗口（<1024）隐藏学习栏，学习插件改用侧栏入口/单页，满足 T04 的回退要求；
- 宽度由学习插件通过 `ctx.layout.setLeftmain(px)` 控制并自行持久化；`AppFrame` 只负责夹取和拖拽手柄。

草图（T04 实施时按实际类型调整）：

```ts
// index.ts：新增 root single 槽
'studyleft': { kind: 'single', scope: 'root'; owner: StudyLeftOwnerProps } // { width, viewportWidth, canShow }
children: { ..., 'studyleft': { kind: 'single', scope: 'root' } }

// stores.ts
leftmain: 0,
setLeftmain: (d, px) => { d.layoutInfo.leftmain = Math.max(0, Math.round(px)) }

// service.ts
setLeftmain(px: number): void { this.panels.setLeftmain(px) }

// AppFrame.tsx
const leftmainFits = viewport >= SIDEBAR_AUTO_COLLAPSE && cols.center >= CENTER_MIN + LEFTMAIN_MIN
const leftmainWidth = leftmainFits ? clampWidth(layoutInfo.leftmain, LEFTMAIN_MIN, cols.center - CENTER_MIN) : 0
<CenterColumn inert={drawerOpen}>
  {leftmainWidth > 0 && <div className={css.leftmainCol} style={{ width: leftmainWidth }}>
    {renderSlot('studyleft', { width: leftmainWidth, viewportWidth: viewport, canShow: true })}
  </div>}
  <MainPanel ... />
</CenterColumn>
{leftmainWidth > 0 && <DragHandle side="leftmain" left={cols.sidebar + leftmainWidth} ... />}
```

`columns.ts` 不改：中央列宽度仍由现有的三列求解给出，学习/对话再在中央列内分配，因此 `columns.client.spec.ts` 的既有断言全部保留。

### 4.2 成本估算（只读评估，未实施）

| 项 | 文件 | 新增行（约） |
| --- | --- | --- |
| 框架 | `ui-layout/src/client/AppFrame.tsx` | +22 |
| 样式 | `ui-layout/src/client/AppFrame.module.css` | +8 |
| 状态 | `ui-layout/src/client/stores.ts` | +10 |
| 服务 | `ui-layout/src/client/service.ts` | +9 |
| 槽声明 | `ui-layout/src/client/index.ts` | +13 |
| **源码合计** | | **约 62 行（≤100 预算）** |
| 测试 | `tests/app-frame.client.spec.tsx` +75；`layout-store.client.spec.ts` +20；`apply.client.spec.ts` +4 | 约 +99 |
| 文档 | `ui-layout/README.md`、`README.zh.md` | 约 +24 |
| Agent Note | 决策与回退说明 | 约 +25 |
| 补丁产物 | `patches/0002-second-main-column.patch`（含源码/测试/文档） | 约 +210（含上下文更多） |

估算由已删除的 `probes/layout/estimate-route3.mjs` 生成 `probes/layout/evidence/route3.json`（只读读取固定源码树，不写 DSH 源码）；探针随开发完成删除，结论保留在本记录。

`patches/0002` 与 `patches/0001` 触及的文件不重叠（0001 是桌面账号开关，0002 只碰 `ui-layout` 及其测试/README），可以独立反向应用。

### 4.3 测试、locale、快照、升级重放

- **测试**：`pnpm run test:gui`。重点新增 `app-frame` 用例：学习槽渲染 owner props、<1024 隐藏、中央列不足 720 时隐藏、拖拽手柄写入宽度、右栏打开时让位；`layout-store` 增加 `setLeftmain` 的初始化/夹取/归零；`apply` 增加 `studyleft` 声明与卸载断言。现有 40+ 个 `AppFrame` 测试和 `columns` 测试不需要改（中央列内部布局不影响 grid 模板）。
- **locale**：槽本身不产生文案，**0 个新 key**。学习栏的标题/开关由 `plugins/study` 自己的字典提供；如果以后在框架层加折叠按钮，再按 8 个语言各 +1 key 计。本方案刻意不加框架按钮。
- **快照**：不改 session 格式、事件、模型输入，`pnpm run test:snapshot` 不受影响；上游 `test:web` replay 不注册学习槽，组装输出与本补丁前一致，不需要重新录制。若 T04 把学习插件放进 StudyBuddy 自己的截图/验收脚本，另行更新该脚本的期望，不是 DSH 快照。
- **升级重放**：补丁按 0.2.2-rc.1 生成，登记进 `patches/README.md`；DSH 升级后重新生成并跑反向校验（`git apply --check -R`）。`ui-layout` 是布局核心，升级时最容易冲突，按"每次 DSH 升级预留一次 GUI 回归"计。回退时源码恢复后重新 `build:artifacts`/bundle。

### 4.4 风险与边界

1. **中央列挤压**：右栏打开到 760px 时中央列只剩 400px，学习栏自动隐藏；T04 必须给出"学习区被临时隐藏"的可见提示（或切到单页），不能假装还在。
2. **窄窗口**：<1024 隐藏学习栏；学习插件要在侧栏入口保留"学习工作台"页面，避免功能消失。
3. **核心补丁漂移**：`AppFrame` 是上游高频文件；补丁必须带测试并在每次升级重放。
4. **不回改 DSH 上游仓库**：补丁只在本地固定源码树应用，`source/deepseek-harness` 不提交、不清理（与 AGENT.md 一致）。
5. **布局瞬态**：框架 store 本来不持久化宽度；学习栏宽度由插件写自己的 `localStorage` 键，刷新时先读再 `setLeftmain`。失效键回落默认 560。

### 4.5 回退方式

```powershell
# 1. 撤销核心补丁
git -C source/deepseek-harness apply -R patches/0002-second-main-column.patch

# 2. 从 patches/README.md 删除 0002 行，删除补丁文件

# 3. 重建客户端与类型产物
pnpm --filter @deepseek-ai/dsh-client-ui-layout bundle
pnpm run build:artifacts
```

学习插件检测 `typeof ctx.layout.setLeftmain !== 'function'` 时自动退回路线 1 的右栏标签页；数据无迁移（宽度键是布局偏好，不是业务数据）。回退后 1440 下仍是"左对话、右学习"，但功能不丢。

## 5. T04 落地清单

1. 在 `ui-layout` 加 `studyleft` 槽、`leftmain` 状态、`ctx.layout.setLeftmain`、拖拽手柄和 <1024 隐藏；补丁带测试与 README。
2. `plugins/study/client/**` 注册 `studyleft`（学习工作台），默认宽度 560、可拖、记忆；不带 session 也渲染"今日/周 + 任务"的空态。
3. 中央列 <720 或视口 <1024 时隐藏学习栏，并在侧栏保留学习页入口；这是"窄窗口自动回退"的落地方式。
4. 保留 `patches/0001` 的校验命令；新增 `patches/0002` 的 `apply --check -R` 证据。
5. 验收按 T04 卡：1440×900 并列可用且拖拽不卡；窄窗口回退；重启恢复；原生对话/附件/工具调用不受影响；`pnpm run test:gui` 通过。

## 6. 证据索引

| 内容 | 路径 |
| --- | --- |
| 路线 1 报告 | `probes/layout/evidence/route1/route1.json` |
| 路线 1 空白会话学习区 | `probes/layout/evidence/route1/route1-blank-session-study.png` |
| 路线 1 最宽（导航展开 / 轨道） | `.../route1-widest.png`、`.../route1-widest-collapsed-sidebar.png` |
| 路线 1 全局面板消失 | `.../route1-global-panel.png` |
| 路线 1 重启恢复 | `.../route1-reload.png` |
| 路线 2 报告 | `probes/layout/evidence/route2/route2.json` |
| 路线 2 左停靠 + 对话 | `probes/layout/evidence/route2/route2-dock-left-chat.png` |
| 路线 2 悬浮窗 | `.../route2-floating.png` |
| 路线 2 编辑器区被隐藏 | `.../route2-docked-editor.png` |
| 路线 3 成本估算 | `probes/layout/evidence/route3.json` |
| 路线 3 实施证据 | 旧 shell 的 `dual-pane.json` 与 13 张截图（2026-11-14 随 `plugins/study` 删除；清理归档保留副本） |

复跑方式与沙箱注意事项原本见 `probes/layout/README.md`；**该探针目录与上述证据已随开发完成删除，结论保留在本记录，可从 git 历史取回。**

## 7. T04 实施记录（2026-11-10）

实际落地与 4.1 的草图有三处按真实类型调整：

| 项 | 实施 |
| --- | --- |
| 槽与状态 | root 单值 `studyleft`；`layoutInfo.leftmain`（0 = 隐藏）；`ctx.layout.setLeftmain(px)`；`savedWidth` 也交给占用方，避免挤压后的渲染宽度覆盖用户偏好 |
| 夹取 | 渲染宽度 `clampWidth(savedWidth, 320, 中栏 − 400)`；框架 <1024px 或中栏 <720px 时整列不渲染；拖拽下限 320，拖过最窄不会隐藏 |
| 持久化 | 框架不写 Storage；`plugins/study/client/studyleft.js` 保存 `study.layout.leftmain.width` 并在启动时恢复；`study.layout.page` 记忆最后打开的学习页，回到对话时清空（宽度键与 `studyleft.js` 已于 2026-11-11 删除，见第 8 节） |
| 补丁 | `patches/0002-second-main-column.patch`，5 个手写源码文件 +97/−7（≤100），客户端测试 +98 行、双语 README、Agent Note 三件；生成物 `slot-catalog.ts` +35/−3（`verify-client-catalog` 通过）；另补 `ui-sidebar`/`ui-workspace` 测试桩的 `setLeftmain` 以过类型检查；补丁文件 749 行 |
| 验证 | 历史命令 `node plugins/study/tests/client/dual-pane-smoke.mjs`（脚本已随旧 shell 删除）当时 passed=true（1440×900：280/560/600 首屏、0 条消息可用、拖拽 630/530、最窄 320、1200px 夹到 520 而保存值 630、刷新恢复页面与宽度、1023px 回退）；`pnpm run test:gui` 743/744 文件（唯一失败是 Windows symlink 环境权限）；`pnpm run typecheck` 5/5；`git apply --check -R patches/0002-second-main-column.patch` 退出 0 |

与 4.5 的差异（已知限制）：未实现“补丁缺失时退回路线 1 右栏标签页”。补丁缺失时 `installStudyLeft` 打警告且不注册 `studyleft`，学习功能仍可从侧栏「工作台/今日」页进入；没有引入 `sidebarRightTabs` 的并行入口。框架层也不提供“学习栏被隐藏”的提示条，窄窗/挤压时的可见入口是侧栏学习页。

## 8. 2026-11-11 产品调整：撤掉常驻学习栏，合并进工作台

学生反馈中间栏的“学习工作台”常驻占用宽度，和右侧完整工作台重复。调整如下：

- **停止注册 `studyleft`**：`plugins/study/client/plugin.js` 不再调用 `installStudyLeft`，`studyleft` 槽保持空值、`layoutInfo.leftmain` 为 0，框架不再渲染第二主栏或拖拽手柄。核心补丁 `0002` 仍保留在源码树中作为未启用的能力，不影响当前布局；若确认以后也不需要，可另行反向应用并重建 `ui-layout`。
- **合并到工作台**：工作台页面新增 `完整 / 缩略` 显示开关。`缩略` 展示今天的学习/固定课程汇总、今日安排的前 6 个时间块和“剩余 N 块”，不显示任务表单、进度编辑和日/周切换；底部按钮“切换到完整显示”回到原工作台。
- **偏好**：`study.workbench.display` 保存 `full|compact`，默认 `full`；缩略视图只读取 `tasks.day`，不写入任何学习数据。
- **仍保留**：`study.layout.page` 继续记住最后打开的学习页；工作台页仍在侧栏入口可达。
- **废弃**：`studyleft.js`、`messages/studyleft.js`、`study.layout.leftmain.width` 和 T04 的 `dual-pane-smoke.mjs` 不再适用，已由 `tests/client/workbench-display.test.mjs` 覆盖显示切换。

验证：`node --test --test-isolation=none plugins/study/tests/client` 57/57；真实应用（Electron 渲染进程）中 `[data-studyleft-col]` 与 `[data-side="leftmain"]` 均为 0，工作台 `data-display=full` 可切到 `compact` 再切回，刷新后仍恢复 `compact`；完整套件 555 例 553 pass / 1 known fail（`outcomes/performance` 月查询约 103–113ms，超过 100ms 门槛）/ 1 skip。
