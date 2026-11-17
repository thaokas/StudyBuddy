# @studybuddy/study-pet

StudyBuddy 的「小搭」桌宠：一个 client-only DSH Web 插件，用 `shell.overlay` 槽位在会话右侧渲染毛绒梨伴静图，并按会话活动 / StudyBuddy 计时器状态说话、碎碎念、睡觉。

- 包名 / bundle id / profile 行 id：`@studybuddy/study-pet` / `@studybuddy/study-pet` / `study-pet`
- 不修改 DSH 源码，不往 `document.body` 手工挂 DOM，无第三方运行时（React 为 external）
- 形象来源：用户指定的成品毛绒梨伴 `assets/logo1.png`（451×423 透明底，抱本子、绿背带、奶油帽、叶冠），复制为 `client/assets/logo1.png` 并由 esbuild 内联为 data URL。**动作后期再补充**：当前为静态形象 + 最小动效。

## 1. 注册面

| 槽位 | id | order | locale | 说明 |
| --- | --- | --- | --- | --- |
| `shell.overlay` | `study.pet` | — | `study-pet` | 浮层宠物本体 + 隐藏后的 🍃 召唤按钮 |
| `settings.general.item` | `study.pet` | 36 | `study-pet` | 设置行：显示开关、碎碎念开关、3 档大小 |

`apply` 只注入 `slots` 与 `locale`；`studyClient` 通过 `ctx.get('studyClient')` 可选读取。`dsh.client` 的 informational inject 为 `ui-layout`、`ui-settings`、`ui-session`、`locale`。

## 2. 能力

形象是成品毛绒梨伴静图，装载在 150×170 容器里以 `object-fit: contain` 等比显示；**各状态不再有专属摆姿**（动作后期再补）。`data-state` 仍按八态更新并驱动语言功能，视觉动作只有：轻微呼吸/浮动、点击挤压、双击弹跳、拖动倾斜。

| 状态 | 触发（保留语义并驱动台词） | 当前视觉 |
| --- | --- | --- |
| `idle` | 无会话活动、静止 | 静图 + 呼吸/浮动 |
| `think` | 有会话 `pendingInteraction` | 静图（共享最小动效） |
| `working` | 有会话 running，或 study 计时运行 | 静图（共享最小动效） |
| `celebrate` | 会话 running 真→假边沿；计时刚完成 | 静图（共享最小动效） |
| `rest` | 计时器 `kind: rest` 运行 | 静图（共享最小动效） |
| `error` | 计时器 `phase: interrupted` | 静图（共享最小动效） |
| `sleep` | 20 s 无手势且无 running | 静图（共享最小动效） |
| `dragging` | 指针拖动中 | 图片倾斜（`--sp-tilt`） |

交互：

- **点击**：图片挤压回弹 + `click` 台词气泡；睡着时点击会醒来并说 `greet`。
- **双击**：短促开心弹跳（`data-happy`）+ 一句回应。
- **拖动**：指针移动超过 4 px 才进入拖动；指针 capture + window 级 `pointermove/pointerup`，移出小宠物也能继续。松手后位置写 `localStorage`，窗口 resize 时重新钳制。
- **左右对称**：宠物在视口右半时图片自动水平镜像（`scaleX(-1)`，面朝页内），左半保持原朝向；拖动换边时实时更新，容器与图片比例不变。
- **悬停 / 键盘聚焦**：出现小面板「隐藏 / 摸摸头 / 碎碎念一句」。
- **隐藏**：设置行开关或面板「隐藏」→ 宠物消失，右下角出现 🍃 召唤按钮；召唤按钮或设置行可恢复。

语言功能：

- `lines.js` 内置 zh/en 台词包，13 个场景：`idle / think / working / done / error / rest / sleep / click / pat / chatter / timerStart / timerFinish / greet`，每场景 4–8 句，zh/en 键集合完全一致。
- 状态气泡：由 `useSessionStatus`（`running` / `pendingInteraction` / `completionUnread`）驱动；`done` **只在 running 真→假边沿**触发一次；气泡存活 4 s，同一场景 9 s 冷却，长场景（think/working/rest）每 8 s 换一句。
- 碎碎念：默认开，空闲（idle）时每 45–90 s 说一句，与状态气泡共用表面。
- 睡觉：20 s 无手势进入 sleep；sleep 期间不冒状态气泡、不碎碎念，只每 60–120 s 说一句梦话；点击/拖动醒来并打招呼。
- 计时器联动：`ctx.get('studyClient')` 存在时每 20 s 调 `timer/status`；study 运行 → 专注状态与 `timerStart`/`working` 台词，rest 运行 → `rest`，interrupted → `error`，刚 finished（90 s 内）→ `celebrate` + `timerFinish`。服务不存在或调用失败时**静默降级**，不产生错误提示。
- 中英跟随 `ctx.locale`（`hooks.locale` 的 `useLocale` 读取 active locale，locale 切换后下一次说话即用新语言）；`t` 只用于 UI 文案，宠物台词只走台词包。

> 说明：DSH 的 `useSessionStatus` 只暴露 running / pendingInteraction / completionUnread，没有“会话错误”事实，因此 `error` 状态来自 StudyBuddy 计时器的 interrupted 阶段，而不是会话失败。

## 3. 偏好与存储键

设置行与浮层宠物共享同一个 `createPetStore` 快照；所有读写都包 `try/catch`，Web Storage 被禁时退化为内存态，游戏内行为不受影响。

| 键 | 值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `study-pet:enabled` | `'1'` / `'0'` | 显示 | 显示/隐藏宠物 |
| `study-pet:chatter` | `'1'` / `'0'` | 开 | 碎碎念开关 |
| `study-pet:size` | `'0.85'` / `'1'` / `'1.2'` | `'1'` | 3 档大小，非法值回落 `'1'` |
| `study-pet:position` | JSON `{ "left": number, "top": number }` | 右下角 | 像素位置；损坏/非有限值忽略并回默认位，渲染时按视口钳制 |
| `study-pet:voice` | JSON 台词包（见 §4） | 无 | 覆盖内置台词；损坏整体忽略并在 console warn |

基础造型 150×170 px，三档缩放后 128–204 px 高；默认距视口右下各 12 px，拖动与 resize 都保持整只宠物在视口内。

## 4. Voice pack（可替换台词包）

在 `localStorage` 的 `study-pet:voice` 放一份 JSON，即可整体替换部分台词；未提供的场景保留内置台词：

```json
{
  "status": {
    "idle": ["我先安静待着。", "你慢慢来。"],
    "done": ["这一页收工。"]
  },
  "click": ["叫我？我在。"],
  "chatter": ["窗外的云走得很快。"],
  "sleep": ["梦里有棵会发光的树。"]
}
```

规则（`voice-pack.js`，全部有单测）：

- 顶层只允许 `status` / `click` / `chatter` / `sleep`；`status` 的场景只允许 `idle`、`think`、`working`、`done`、`error`、`rest`、`greet`、`timerStart`、`timerFinish`。
- 每个池必须是字符串数组，**≤64 句**，每句**≤160 字符**、非空、单行。
- 校验是**整体式**：任何一个类型/键/长度问题都会忽略整份台词包并 `console.warn`，不会留下半套台词。
- 空数组视为“不覆盖该池”，继续用内置台词。
- 台词包是语言中立的：覆盖同时作用于 zh/en；`pat` 目前只保留内置池（格式未包含）。
- 台词包在组件挂载时读取一次；改完刷新页面生效。

## 5. 可访问性

- 可点击主体是原生 `<button>`，`aria-label` 来自 `pet.alt`（小搭宠物 / StudyBuddy buddy）；宠物图片 `alt=""` + `aria-hidden="true"`，不参与朗读。
- 气泡 `role="status"` + `aria-live="polite"`；悬停面板 `role="group"` 并带本地化 label；隐藏召唤按钮有本地化 `aria-label`。
- 设置行：显示/碎碎念是 `role="switch"` + `aria-checked`，大小 chips 用 `aria-pressed`；键盘 Tab 可达，焦点环用 `--dsw-focus-ring-color`。
- `prefers-reduced-motion: reduce`：静图呼吸/挤压/弹跳、镜像包裹层过渡、气泡入场与悬停面板 120 ms 过渡全部归零，拖动倾斜也取消。降级规则用与动画规则同 specificity 的选择器（如 `[data-study-pet][data-squash='true'] .sp-photo`）列在动画规则之后，靠 source order 生效，不写 `!important`；`pet-smoke` 在 `emulateMedia({ reducedMotion: 'reduce' })` 下实测图片 `animationName === 'none'`、气泡 `animationName === 'none'`、面板与包裹层 `transitionDuration === '0s'`。
- `prefers-contrast: more`：气泡/面板/召唤按钮用实色底 + 1px 边框；`forced-colors: active` 下改用 `Canvas`/`CanvasText` 系统色。
- 气泡与面板走语义 token（`--dsw-alias-bg-layer-1`、`--dsw-alias-label-primary`、`--dsw-alias-border-l3`、`--dsw-elevation-panel`），跟随 DSH 明暗；毛绒图片保留原图奶油/嫩芽色（不随主题反相）。

## 6. 构建与测试

```powershell
# 构建（Loader 读取 client/client.js）
node plugins/study-pet/scripts/build-client.mjs

# 单测：台词包 / voice pack / 状态机 / store / 几何 / 气泡 / 样式 / 装配 / 构建产物
node --test "plugins/study-pet/tests/**/*.test.mjs"

# 真实 Edge 冒烟：加载、图片 data URL/镜像、点击气泡、拖动+reload 记忆、设置行/大小/隐藏、reduced-motion、深浅色截图
node plugins/study-pet/tests/pet-smoke.mjs
```

构建产物断言：bundle 含 `window.__ModuleLoader__.load({ id: "@studybuddy/study-pet" })`、`data:image/png;base64,` 形式的 logo1 内联图、`sp-photo` 元素，除 `react` 外没有外部模块请求；`client/assets/logo1.png` 由单测校验为 451×423 PNG。

冒烟证据：`tests/evidence/pet-smoke.json` + `pet-light.png` / `pet-bubble.png` / `pet-settings.png` / `pet-hidden.png` / `pet-reduced-motion.png` / `pet-dark.png` + host 日志。

## 7. Profile 集成（由集成方添加）

本包不修改 `scripts/project-config.mjs`。集成时在 `deploymentPolicy(root)` 的 `insert` 列表补一行即可（无需 config）：

```js
{ id: 'study-pet', name: join(project, 'plugins/study-pet/host/index.mjs').replaceAll('\\', '/') },
```

启动前先跑一次构建；开发期改客户端代码后要重新 `build-client`，Loader 读的是 `client/client.js` 而不是源码。

## 8. 第三方灵感与许可证

语言功能与工程做法参考了以下开源桌宠项目。**本项目只借鉴概念与交互模式，所有代码与台词均为自写实现，未复制其源代码或美术资产。** 宠物形象来自本仓库品牌素材 `assets/logo1.png`（用户指定），不属于下表任何项目。

| 项目 | License | 借鉴点 | 未采用 |
| --- | --- | --- | --- |
| [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（核心参考，6250★） | MIT | 语言功能：状态气泡、碎碎念、人设/台词包、睡觉梦话、中英双语、工作状态联动 | 106 段动画 / 位图美术资产、对话窗、TTS、待办 |
| [nzl153/dsh-pet-whale](https://github.com/nzl153/dsh-pet-whale) | MIT | 纯 DOM 网页桌宠工程做法：状态机、拖拽与位置记忆、i18n、`prefers-reduced-motion` 降级 | 鲸鱼造型、其代码 |
| [zhu1090093659/dsh-pet](https://github.com/zhu1090093659/dsh-pet) | Apache-2.0 | registry 驱动的多宠物、remarks / `voice.json` 台词包的组织方式 | 多宠物注册表、熟络度系统 |

许可证文本版权归各原作者所有；本仓库发布时保留上述署名与许可证信息。外观与桌宠的设计规范见 [`docs/design/study-pet.md`](../../docs/design/study-pet.md) 与 [`docs/design/appearance-plugin.md`](../../docs/design/appearance-plugin.md)。

## 9. 非目标 / 已知限制

- 不做 TTS、模型对话、独立聊天窗、待办或业务数据读写；不接 `studyClient` 的写接口（只读 `timer/status`）。
- 形象当前是静态成品图；各状态专属摆姿/帧动画**后期再补充**，`data-state` 已保留、语言功能已区分状态。
- 镜像只翻转图片本身（包裹层 `scaleX`），不改变容器尺寸、点击区域或图片比例。
- 不新增 DSH 主题 id、不覆盖宿主 token；宠物偏好按浏览器保存，不跨设备同步。
- `error` 只由计时器 interrupted 触发（会话状态面没有 error 事实）。
- 触摸端可点击、可拖动，但悬停面板依赖 hover/focus；隐藏/召唤与大小仍可在设置行操作。
- 小宠物可拖到任意视口内位置；暂无“一键回右下角”UI（store 已提供 `clearPosition`，本阶段未暴露入口）。
