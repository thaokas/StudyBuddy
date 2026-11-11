# 核心补丁

StudyBuddy 对固定 DSH 源码的改动集中在这里，目的是一眼看清"我们改了什么"，升级时可重放或退回。

## 0001-desktop-account-toggle.patch

- **作用**：给桌面壳增加 `DSH_DESKTOP_ACCOUNT_ENABLED` 开关。设为 `0` 时跳过 DeepSeek 账号引导与账号流订阅，直接进入工作区；省略或 `1` 保持原生行为；其他值启动失败。
- **范围**：9 个文件，+72/−7（8 个修改 + 1 个新增测试）。只涉及 `apps/desktop/`，不碰 Host、Agent 循环、Web 前端与锁文件。
- **基线**：`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`（0.2.2-rc.1）。
- **配套**：`scripts/project-config.mjs` 在 profile 中禁用账号相关 bundle 并设置 `DSH_DESKTOP_ACCOUNT_ENABLED=0`。

## 0002-second-main-column.patch

- **作用**：在 `AppFrame` 的中栏内增加第二个主栏 `studyleft`。宽度由 `ctx.layout.setLeftmain(px)` 控制，框架夹取（最低 320px、给对话留 400px）、绘制拖拽手柄，并在框架 <1024px 或中栏 <720px 时隐藏。该能力 2026-11-11 起不再被 StudyBuddy 注册（学习概览已合并进工作台的“缩略”显示），补丁保留为未启用能力。
- **范围**：5 个手写源码文件 +97/−7（`packages/client/ui-layout/src/client/` 的 `AppFrame.tsx`、`AppFrame.module.css`、`index.ts`、`service.ts`、`stores.ts`）；同包客户端测试与两份 README；Agent Note 中英与配对记录；生成物 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` +35/−3（`pnpm run gen-client-catalog` 输出，新增 `studyleft` 条目，`verify-client-catalog` 通过）。另补 2 个消费方测试桩（`ui-sidebar`、`ui-workspace`）的 `setLeftmain` 假实现各 1–2 行，否则类型检查失败。0 个新 locale key（槽本身不产生文案）。
- **基线**：`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`（0.2.2-rc.1）。
- **配套**：`plugins/study/client/lib/study-page.js` 继续记住最后打开的学习页；旧的 `studyleft.js`、宽度键 `study.layout.leftmain.width` 已于 2026-11-11 删除。方案、调整与回退见 `docs/decisions/layout.md` 路线 3 及第 8 节。

## 校验

补丁与当前源码树一致（反向应用能通过，说明工作树内容就是补丁内容）：

```powershell
git -C source/deepseek-harness apply --check -R "$PWD/patches/0001-desktop-account-toggle.patch"
git -C source/deepseek-harness apply --check -R "$PWD/patches/0002-second-main-column.patch"
```

重新生成（包含新增文件）：

```powershell
git -C source/deepseek-harness add -N apps/desktop/tests/account-policy.spec.ts
git -C source/deepseek-harness diff --output="$PWD/patches/0001-desktop-account-toggle.patch"
git -C source/deepseek-harness reset --quiet
```

0002 的重新生成还要 `add -N` 三个新增的 Agent Note 文件（`2026-11-10-second-main-column.md`、`.zh.md`、`.i18n.yaml`），再按 `packages/client/ui-layout`、`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`、两个消费方测试桩与这三个文件列出路径生成 diff。槽目录不要手改：先改 `SlotMap`，再跑 `pnpm run gen-client-catalog`。

重建与测试（布局客户端包从 `lib/client.js` 提供，改源码后必须先 bundle）：

```powershell
pnpm --filter @deepseek-ai/dsh-client-ui-layout bundle
pnpm run test:gui
```

## 升级 DSH 时

1. 在新提交上先还原干净树（`git -C source/deepseek-harness checkout -- .` 并删除未跟踪的本补丁新增文件）。
2. `git -C source/deepseek-harness apply --3way patches/0001-desktop-account-toggle.patch patches/0002-second-main-column.patch`。
3. 冲突时按语义重做，更新本补丁与上面的基线提交。
4. 跑 `apps/desktop` 的相关测试、`pnpm --filter @deepseek-ai/dsh-client-ui-layout bundle`、`pnpm run test:gui` 与 `node tests/project/desktop.test.mjs`。

补丁预算：单一补丁 ≤100 行、只碰 `apps/desktop` 或通用布局；超出必须由用户批准（见 PLAN 3.4）。
