# T02：客户端构建与页面骨架

> 任务卡只写要求；状态以 [STATUS](../STATUS.md) 为准。开工前先读 [AGENT.md](../AGENT.md)。

- 预计：1 个会话
- 依赖：T01
- 波次：W2
- 状态：见 [STATUS](../STATUS.md) 的 T02 行

## 目标

插件前端可构建、可注册、能显示真实数据，且不改 DSH 核心。

## 所有权（只能改这些路径）

- `plugins/study/client/**`
- `plugins/study/scripts/build-client.mjs`
- `plugins/study/tests/client/**`
- `plugins/study/package.json` 中构建相关字段与 devDependency

## 交付

- esbuild 构建：自动发现 `client/pages/*.js` → 生成 barrel → 单 bundle；`react` 外置；产物包进 `window.__ModuleLoader__.load`（与 `probes/A02/client.js` 同形态）。
- 页面注册（`main` + `sidebar.panellist`）、locale（zh/en）按页合并、加载/错误/空态。
- 一个只读"今日"页，读取 `kernel.status` 的真实数据。
- `client/actions` 动作注册表，供后续任务加按钮而不改别人页面。
- UI 冒烟脚本：启动 → 打开学习页 → 截图 + 断言。

## 验收

- `node plugins/study/scripts/build-client.mjs` 成功。
- 页面出现在侧栏并显示真实数据。
- 停用插件后入口消失且应用不崩。
- 无硬编码文案，全部走 locale。

## 不做

- 拖拽、编辑、布局、业务模块。
- 修改 `source/deepseek-harness` 的客户端代码。

## 开工前

1. 读 [AGENT.md](../AGENT.md)，确认工程约定与完成标准。
2. 在 [STATUS](../STATUS.md) 确认依赖 T01 均为 DONE；不满足就停下并在 STATUS 写 BLOCKED。
3. 只改"所有权"里的路径；需要共享文件时按 AGENT.md 串行处理。
4. 先写测试或证据脚本，再改实现。

## 完成后

1. 跑测试，记录命令与真实结果（失败也要写）。
2. 把 STATUS 的 T02 行改为 DONE / REVIEW / BLOCKED，填证据与已知限制。
3. 不修改其他任务的状态，不顺手重构无关代码。
