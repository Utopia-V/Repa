# 基础组件换成 Fluid Functionalism 的 Base UI 版

状态：提案

本记录是新 UI 落地三个 PR 中第 1 个的规格。依据 `dev` 的提交 `4d8522d19` 和 Fluid Functionalism（下称 FF）仓库 [`mickadesign/fluid-functionalism`](https://github.com/mickadesign/fluid-functionalism) 的提交 `7e6ae29`（2026-11-06，新西兰时间）。基线是 `origin/dev`，不带 `aqua256/issue-101-ui-text` 分支的提交。

## 问题

新 UI 用 FF 的组件和动效，`apps/web/src/components/ui` 现在是 shadcn + Radix。`apps/web/AGENTS.md` 不允许第二套基础 UI 库，所以新页面落地之前，基础组件要先整体换掉，否则第 2、3 个 PR 只能在旧组件上写新页面，或者让两套并存。

界面文字和跨页面行为也卡在这一层：文字散在 26 个文件里，#114 要求集中到字符串文件；输入法、Esc、失败保留、减少动效、焦点恢复各页做法不一。这些都要改动基础组件，放在同一次替换里只改一遍。

## 做法

### 范围

做：`components/ui` 的 20 个组件换成 FF Base UI 版或按 FF 令牌重写；主题、字体、规范文档；#114 的字符串文件、检查和五种行为。

不做：页面结构和布局（学习线在第 2 个 PR，设置、学过的内容、搜索在第 3 个 PR）；首次打开、无模型、断线重连；手机端；深色模式；新增界面文字；#101 的删字和用词表，以及 `docs/ui-text.md`（都在未合入的 `aqua256/issue-101-ui-text` 分支上）。

### 来源与本地改动

不用 shadcn CLI，也不加进依赖。按下面的清单从 `7e6ae29` 复制源码，每个文件第一行加 `// Adapted from Fluid Functionalism (MIT); see README.md.`，`@/` 别名不用改。复制手段简单，审阅者也能逐文件对照上游。

| 位置 | 文件 | 来源 |
| --- | --- | --- |
| `components/ui` | `button` `dialog` `checkbox` `select` `switch` `scroll-area` | `registry/base` |
| `components/ui` | `input` `textarea` `badge` `banner` `fluid-hover-highlight` | `registry/default` |
| `lib` | `springs` `font-weight` `omit` `popup` `shape-context` `size-context` `type-scale` `icon-context` `surface-context` `surface-classes` `elevated` `fluid-provider` | `registry/default/lib` |
| `lib/utils.ts` | 换成 FF 的 `cn`（扩展了 tailwind-merge，能识别 `text-body` 等字号类） | `registry/default/lib/utils.ts` |
| `hooks` | `use-fluid-hover` `use-touch-primary` `use-keyboard-nav-gate` | `registry/default/hooks` |

根节点在 `main.tsx` 包一层 `FluidProvider shape="rounded" size="default"`。图标继续用 Lucide。

FF 建议不改已安装的组件，这里仍有必须改的地方，全部记入 `components/ui/README.md`，升级时逐条核对：

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `dialog` `select` `switch` `banner` `use-fluid-hover` `fluid-provider` | 修 7 处类型错误 | `apps/web` 开了 `exactOptionalPropertyTypes` 和 `noUncheckedIndexedAccess` |
| `dialog` `select` `input` `banner` | 写死的英文（`Close`、`Select…`、`Increase`、`Decrease`、`Dismiss`）换成字符串键 | #114 |
| `button` | 加 `data-variant` | `learning-space.test.tsx` 按它区分首要按钮 |
| `dialog` | 默认 `max-h-[calc(100dvh-2rem)] overflow-y-auto`；Esc 只关最上层（见 #114 一节） | FF 没有高度上限，长内容会超出窗口 |
| `input` `textarea` | 接入组合输入保护 | #114 |
| `input` `textarea` `select` `checkbox` | 边框用 `input`，聚焦用 `input-focus` | 已定 5 |

### 组件对应

“调用处”的路径相对于 `apps/web/src`。

| 组件 | 引用 | 换成 | API 差异 | 调用处 |
| --- | --- | --- | --- | --- |
| `button` | 24 | FF `base/button` | variant：`default`→`primary`，`outline`→`tertiary`，`ghost`、`destructive` 同名；size：`md`→默认（高度 40→36），`icon` 同名。`asChild` 保留。默认 `type="button"` 由 Base UI 提供。文字不换行 | 全部按表改 variant，38 处 `outline`。`learning-space.test.tsx` 的两个断言改成 `tertiary`/`primary` |
| `dialog` | 11 | FF `base/dialog` | 没有 `DialogPortal`、`DialogOverlay`（无外部调用）。默认宽 400，有 `size="lg"`（540）。内容不再自带 `grid gap-4` | 12 处 `DialogContent` 加 `size="lg"`（现在是 512），多块内容的加 `className="grid gap-4"`；`concept-card` 的 `sm:max-w-2xl` 改 `size="xl"` |
| `status-notice` | 8 | 保留组件和 props，内部用 FF `banner` | `complete`→`status="success"`，`error`→`status="error"`，`contrast="high"`；`title`→`BannerTitle`，`children`→`BannerDescription`。`role` 由 Banner 给，与现在一致 | 不改 |
| `markdown` | 7 | 保留渲染逻辑，样式换 `.typeset` | 插件、`remend`、Shiki、`renderLink`、地址清理、标题降级都不动。元素上的排版 class 删除，只留代码块（`.not-typeset`）、任务列表、KaTeX。`.typeset` 再覆盖 15/27 和前景色 | 不改 |
| `textarea` | 5 | FF `textarea` | 多 `size`；默认 3～10 行自动增高 | 不改；`code-field` 核对最小高度 |
| `card` | 4 | 保留组件和子部件，按 FF 令牌重写：`surfaceClasses` 第 3 层、`shape.container`、`p-4` | FF `card` 默认无边框、无内距，子元素不放进 `CardContent` 就贴边，还依赖 `next/link`，原型也没用过 | 不改 |
| `badge` | 3 | FF `badge` | `secondary`→`variant="solid" color="gray"`；`outline`→`variant="dot" color="gray"`；`complete` 无调用，去掉 | `folder-picker`、`prompt-settings`、`provider-connect` 共 4 处 |
| `input` | 3 | FF `input` | 原生 `size` 属性被占用（无调用） | 不改 |
| `sidebar` | 3 | 保留，`Slot` 换成 Base UI `useRender`，颜色、字号换 FF 令牌 | FF sidebar 没有图标栏（`collapsible` 只有 `offcanvas`、`none`）、没有 `onWidthChange`，宽度范围 160～360（现在 200～480） | 不改；`sidebar.test.tsx` 不动。见已定 1 |
| `radio-group` | 3 | 保留组件和 API，内部用 Base UI `RadioGroup`、`Radio`，视觉照 FF（16 px 圈、8 px 点、`spring.fast`） | FF 的 `RadioItem` 只收字符串 `label`，组上没有 `disabled`，而 `item-form` 的选项是 Markdown 加标记和“其他”输入框 | 不改。见已定 2 |
| `sheet` | 2 | 保留 API，内部换 Base UI `Dialog`，进出场照 FF `SidebarSheet` 用 `spring.moderate` | FF 的抽屉 `mobile-drawer` 只能从底部出现，`SidebarSheet` 没有导出 | 不改 |
| `selection-button` | 2 | 保留 API，内部用 Base UI `Button` 写成行 | FF `button` 固定高度、文字不换行、子元素包在居中的 span 里，放不下两行的模型名和靠右的勾 | 不改。无调用的 `size="icon"` 去掉 |
| `search-input` | 2 | 保留，内部换 FF `input` 和 `button` | 去掉 `rounded-full`，清空按钮用 `icon-compact` | 不改 |
| `checkbox` | 2 | FF `base/checkbox` | `onCheckedChange` 收 `boolean` | 不改；`next === true` 仍可编译 |
| `select` | 1 | FF `base/select` | `SelectItem` 必须传 `index`；没有 `SelectValue`，占位放在 `SelectTrigger placeholder` | `components/domain/table-field.tsx` |
| `message-bubble` | 1 | 保留，换 FF 令牌 | FF `chat-message` 依赖 `file-thumbnail`，会带入 `pdfjs-dist` | 不改 |
| `input-group` | 1 | 保留本地 `InputGroup`、`InputGroupAddon`、`InputGroupTextarea`，内部用 FF `textarea` 和令牌 | FF 的同名组件是一组带标签的输入框，用途不同。对应形态是 `input-message` | 不改。见已定 3 |
| `progress` | 1 | 保留，内部换 Base UI `Progress` | `aria-valuenow` 由 Base UI 给 | 不改 |
| `switch` | 1 | FF `base/switch` | `onCheckedChange`→`onToggle`；`label` 必填。沿用原型的 `[&>span:last-child]:sr-only` 隐藏可见标签 | `features/prompt-settings.tsx` |
| `selectable-card` | 0 | 删除 | 连同只测它的那条测试一起删 | `test/design-system.test.tsx` |

### 依赖

| 依赖 | 动作 | 版本与说明 |
| --- | --- | --- |
| `motion` | 新增 | `14.10.0`（原型验证过的版本），FF 的动效 |
| `@base-ui/react` | 新增 | `1.9.0`，FF Base UI 版的底层 |
| `@fontsource-variable/inter`、`@fontsource-variable/noto-sans-sc` | 新增 | `5.3.0`、`5.3.1`，见“主题和字体” |
| `@fontsource-variable/manrope`、`@fontsource-variable/plus-jakarta-sans` | 移除 | 不再使用 |
| `radix-ui` | 移除 | 最后一个组件提交里移除，届时 `src` 不再有引用 |
| `tw-animate-css` | 移除 | `animate-in`、`animate-out` 只在被替换的三个组件里用；`animate-spin` 是 Tailwind 自带 |

版本写法沿用 `apps/web/package.json` 的固定版本，用 `npm install --workspace=@repa/web` 更新 lockfile。

已核对：

- 用仓库的 TypeScript 5.9.3、`apps/web` 的编译选项和 `@types/react` 19.3.0 检查 FF 源码：上表用到的文件共 7 个类型错误，都来自上述两个严格选项，没有 React 19.3 的 API 不兼容。原型的 tsconfig 没开这两项。
- 用仓库的 Tailwind 4.3.3 编译 FF 里最特殊的 22 个工具类（`pointer-coarse:`、`field-sizing-content`、`[text-box:…]`、`light-dark()` 任意值等），全部生成。
- `@base-ui/react` 1.9.0 的 peer 是 React `^17 || ^18 || ^19`，`motion` 14.10.0 是 `^18 || ^19`；`remix`、`date-fns` 等 peer 都是可选的，不会装进来。
- 上表用到的文件没有 `any`、`@ts-ignore` 和非空断言，能过仓库的 ESLint 规则。

未核对：Base UI 版组件在 React 19.3 下的实际运行（原型是 React 19.2 + Radix 版），要到实现时在浏览器里确认；FF 的 `stack.mjs`、`audit.mjs` 这次没有运行。

许可：新增 `components/ui/LICENSE.fluid-functionalism.md`，放 FF 的 MIT 全文（Copyright (c) 2026 Micka Touillaud）。`sidebar`、`sheet`、`card` 等仍然源于 shadcn，`LICENSE.shadcn.md` 保留。

### 主题和字体

`globals.css` 仍是 token 的唯一来源，`--theme-*` 私有层和语义层的结构不变。

**Tailwind 基础样式。** 现在只引入 theme 和 utilities，靠 `[data-slot]` 补重置。FF 的按钮等元素没有 `data-slot`，依赖 preflight。改为引入 `tailwindcss/preflight.css`，在 `@theme` 里设 `--default-font-family` 和 `--default-mono-font-family`，删除 `components/ui/styles.css` 里 `[data-slot]` 的重置规则。`h1`～`h3` 和列表失去浏览器默认样式，页面上 46 处标题和列表要在浏览器里逐页看。

**只有浅色。** `:root` 加 `color-scheme: light`，`light-dark()` 因此取浅色值；加 `@custom-variant dark (&:is(.dark *))`，避免系统深色时 `dark:` 类生效。

**颜色。** 取原型的值，只在对比度测试不过时调整：

| Token | 值 | 说明 |
| --- | --- | --- |
| `--fluid-accent` | `light-dark(#0084D1, #00BCFF)` | Sky；`--focus-ring` 指向它 |
| `--background` / `--card` | `var(--surface-1)` / `var(--surface-3)` | `#FAFAFA` / `#FFFFFF` |
| `--foreground` | `#171717` | |
| `--primary` / `--primary-foreground` | `var(--foreground)` / `var(--background)` | FF 的主按钮是前景色实底，品牌紫取消 |
| `--muted` | `#F4F4F5` | |
| `--muted-foreground` | `#6E6E6E` | 原型 `#737373` 在 `muted` 上是 4.31，不够 4.5；`#6E6E6E` 是 4.64 |
| `--accent` / `--accent-foreground` | `#E5E5E5` / `#171717` | |
| `--border` | `color-mix(in oklab, var(--foreground) 12%, transparent)` | |
| `--input` / `--input-focus` | `#8C8C8C` / `#6E6E6E` | 输入框类控件的边界，对卡片至少 3:1，见已定 5 |
| `--ring` | `var(--focus-ring)` | 键盘焦点 |
| `--destructive` | `#B91C1C` | 保持现值；原型的 `#EF4444` 作文字只有 3.76 |
| `--status-complete` | `#047857` | 保持现值 |

新增 FF 的 `surfaces`（`surface-1..8`、`shadow-1..8`）、`tokens`（`hover`、`active`、`selected`、`tint`、`tint-hover`、`z-*`）、`type-scale`（`fs-*`、`lh-*`）和 Banner 的 `info`、`success`、`warning`，以及对应的 `@theme` 映射。只抄有效映射，原型里 `--fs-body: var(--fs-body)` 这类自引用不要。`::selection` 和 `:focus-visible` 的基础规则、`spinner-*` 动画、`scroll-area` 的 `@property` 和动画放进 `components/ui/styles.css`；`.typeset` 放进新文件 `components/ui/typography.css`。

删除没有调用方的 token：`--secondary*`、`--overlay`（FF 自己的定义不同）、`--destructive-foreground`、`--control-size`、`--hit-size`、`--button-md-*`、`--corner-*`、`--type-*`、`--space-*` 中不再使用的部分。实现时逐个 grep，有调用方的留下。

**圆角。** FF 的 `rounded-lg` 指 8 px，而 `globals.css` 把 `--radius-lg` 改成了 16 px，`--radius-md` 改成了 8 px。删除这些覆盖，用 Tailwind 默认值；页面上 12 处 `rounded-md` 改 `rounded-lg`，保持 8 px。

**字号字重。** 按已定的六个角色。页面和业务组件机械替换：`text-xs`→`text-caption`，`text-sm`→`text-body`，`text-base`、`text-lg`→`text-title`，`text-xl`、`text-2xl`→`text-display`。删除 `@theme` 里 `--text-*` 的覆盖。`font-semibold`、`font-medium`、`font-bold` 换成三个 `@utility`（`weight-normal`、`weight-semibold`、`weight-bold`，值与 `fontWeights` 相同），不在每个元素上写 inline style。代码现在没有字距类。

**字体。** CSP 的 `default-src 'self'` 不放行 Google Fonts，字体已经走 `@fontsource-variable`（#50），这里换包：

```css
@import "@fontsource-variable/inter/opsz.css";
@import "@fontsource-variable/noto-sans-sc/wght.css";
@import "@fontsource-variable/jetbrains-mono";
```

`--font-heading` 和 `--font-body` 都是 `"Inter Variable", "Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", sans-serif`。

- Inter 要带 `opsz` 轴，`fontWeights` 靠它在变粗时保持字宽。
- Noto Sans SC 必须打包：`fontWeights` 通过 `font-variation-settings` 调字重，对苹方、微软雅黑这类非可变字体无效，中文标题和选中项不会变粗，而 `font-synthesis: none` 也不会补。代价是发布物增加约 4.5 MB（101 个 woff2），浏览器按 unicode-range 只下载用到的切片。

`vite.config.ts` 里 `assetsInlineLimit` 的字体规则继续有效。

### 规范文档

| 文件 | 要改的地方 |
| --- | --- |
| `docs/design-system.md` | 排版：字体改 Inter + Noto Sans SC，字号表换六个角色，删“常规正文至少 14 px”。圆角、控件高度（36）、Button variant 和尺寸换新值。焦点：2 px `ring` 改 1 px `focus-ring`，输入框聚焦加深边框，边框用 `input`，对比度至少 3:1，这处和组件库原样不同。色彩表加 `focus-ring`、`hover`、`active`、`selected`、`surface-*`。新增动效一节（`spring.fast/moderate/slow`，只动 transform 和 opacity） |
| `docs/design-system-implementation.md` | 第 15、23、25、31 行写 shadcn、Radix 的地方；主题名 Ultramarine Workspace；第 14 行字体包；“工作台侧栏”写明基于 shadcn 结构、底层换成 Base UI |
| `apps/web/AGENTS.md` | “优先复用 shadcn 组件”和“复用现有 shadcn/Radix 的焦点管理”改成 FF 和 Base UI；上游文件允许的例外（`bg-black/40`、回退色）写一句；“界面文字”一条指向 `src/strings/zh-CN.ts` 和下面 README 的用法。`budgets.json` 给这个文件的上限是 2500 字符，只替换不加长 |
| `components/ui/README.md` | 重写来源与版本（FF 仓库、提交、许可）、本地改动清单、保留组件的来由；删除 Radix 依赖说明；新增“界面文字”一节，写字符串文件的位置、键名、`t()`、占位和检查 |

提案记录 `2026-11-06-ui-strings-and-components.md` 按 `.agents/notes/README.md` 由本 PR 移入 `implemented/` 并改写，`apps/web/AGENTS.md` 的链接同步。

### #114：字符串文件

文件是 `apps/web/src/strings/zh-CN.ts`，内容就是一张扁平表，不读 React 也能改：

```ts
export const strings = {
  // 设置
  "settings.commandPolicy.title": "命令授权",
  "promptSettings.section.enable": "启用 {name}",
  // ……
} as const satisfies Record<string, string>;
```

- **键名：** `区域.对象.用途`，英文小驼峰。区域按页面或功能（`settings`、`learn`、`tutor`、`conversation`、`history`、`learningSpace`、`folderPicker`、`modelPicker`、`provider`、`feedback`、`promptSettings`、`sidebar`、`item`、`error`），跨页面含义相同的放 `common`。用途用固定的词：`title`、`description`、`label`、`placeholder`、`action`、`error`、`empty`。文件按区域分组。
- **引用：** `src/lib/strings.ts` 导出 `t(key, params?)`。键和 `{name}` 参数都由类型检查，写错过不了 `tsc`。多语言时按语言加文件，结构不变。
- **占位：** 值写成 `〔待写〕`。Agent 新增元素只能写这个值。
- **迁移：** 按 `origin/dev` 现有文字迁移，#101 和审阅表定为删除的句子这次也照搬，之后由人在字符串文件里改。只移动已有文字，`${x}` 改成 `{x}`，一字不改。`dev` 的停用词检查覆盖 `.ts`，`zh-CN.ts` 会进入扫描范围，现有文字没有命中。实现时用一次性脚本对比：字符串文件里每个值（去掉占位）都要能在迁移前的源码里找到原文，结果写进 PR 描述。FF 组件里没有现成中文的英文文字：`Close`、`Select…` 用现有的“关闭对话框”“选择”；`Increase`、`Decrease`、`Dismiss` 目前无调用，留占位。

规模：`src` 里 26 个文件含中文字面量，约 150 处，另有 `History`、`Settings` 等英文标签。

**检查放在 `scripts/checks/ui-strings.ts`**，和 `browser-boundary.ts` 并列，接入根目录 `npm run lint`：

- 字面量：用 TypeScript AST 扫描 `apps/web/src`（不含 `strings/`、测试）。含中文的字符串和模板、JSX 文字、`title`/`aria-label`/`placeholder`/`alt`/`label` 属性里的英文，都报文件、行号和改法。开发用标记写 `// ui-text: ignore 原因` 豁免。`const x = "Settings"` 这种纯英文常量查不出，靠审查。
- 占位：`lint` 列出所有占位但不失败，这样 Agent 的分支能带着占位提交给人写。`desktop-package.yml` 打包前运行 `--no-placeholders`，有占位就失败，保证不交给学习者。

### #114：五种行为

新测试文件 `apps/web/test/base-behaviors.test.tsx`，每种行为只在这里测一次。

| 行为 | 落在哪里 | 怎么测 |
| --- | --- | --- |
| 输入法选字 | 新 hook `hooks/use-composition-guard.ts`，接入 `Input`、`Textarea`。`isComposing` 或 `keyCode === 229` 时，Enter 和方向键不调用外部 `onKeyDown`；229 的 Enter 另外阻止隐式提交（Safari 确认候选词时 `isComposing` 已经是 false）。`message-composer.tsx` 里的判断删除。FF 自身只有 `command-menu` 判断了 229 | `fireEvent.keyDown` 带 `isComposing: true` 和 `keyCode: 229`，外部回调和表单提交都不触发 |
| Esc 逐层退出 | `dialog`、`sheet`、`select`。Base UI 只处理 React 树内的嵌套，`CommandConfirmationDialog` 和其他弹窗是兄弟关系。先写测试，不成立则在 `dialog` 和 `sheet` 里维护模块级打开栈，非栈顶时在 `onOpenChange` 里 `details.cancel()` | 对话框里开 Select、对话框里开对话框、两个兄弟对话框，每按一次 Esc 只少一层 |
| 失败时保留输入 | 新 hook `hooks/use-draft-send.ts`：先清空，失败时还原，除非用户已开始写下一条。`pages/conversation.tsx` 和 `features/tutor-panel.tsx` 现在各写了一份，替换掉。表单和弹窗：`Dialog` 在失败时不关闭、内容不卸载，由 Input、Select 受控值保持 | hook：发送返回失败，内容回到输入框；期间写了新内容时不覆盖。对话框表单：提交 reject 后值还在 |
| 减少动效 | `FluidProvider` 给 `MotionConfig reducedMotion="user"`，但淡入淡出仍然保留，而 #114 要求停止动画。根节点按 `matchMedia` 设 `MotionGlobalConfig.skipAnimations`，并监听变化。CSS 动画：`styles.css` 把 `[data-slot]` 的规则扩大到 `*`、`::before`、`::after` | mock `matchMedia` 后打开 Dialog，首帧即为终态，`onAnimationComplete` 后卸载正常；读 `styles.css` 确认规则存在 |
| 焦点恢复 | `dialog`、`sheet`、`select` 用 Base UI 的默认行为，不另写。`sidebar` 现有的触发器恢复保留 | 由触发器打开、由外部按钮受控打开、Select，关闭后焦点都回到原处。现有的“Escape 关闭后恢复触发器焦点”保留 |

### 提交拆分

一个 PR，提交格式 `type(web): 中文`。每个提交通过 check 和 test，能单独回退。

1. 依赖、许可、FF 共享的 `lib`、`hooks`（原样加改类型）。
2. 主题 token、preflight、字体、圆角。
3. 字符串文件和 `t()`，`ui-strings` 检查先不接入。
4. Button、SelectionButton 及调用处。
5. Input、Textarea、SearchInput、InputGroup、组合输入保护。
6. Checkbox、RadioGroup、Switch、Select。
7. Dialog、Sheet，加 Esc 和焦点测试。
8. Badge、Card、StatusNotice、Progress、MessageBubble。
9. Markdown 换 `.typeset`。
10. Sidebar 换 `useRender`。
11. 删 `selectable-card`，移除 `radix-ui`、`tw-animate-css`，清理无用 token。
12. 页面字号、字重类的机械替换，单独一个提交。
13. 界面文字迁移，按区域分几个提交；最后一个接入 `ui-strings` 检查。
14. `use-draft-send` 和减少动效。
15. 文档、提案移到 `implemented/`。

### 验证

在仓库根目录依次运行：

```sh
npm run check --workspace=@repa/web
npm run lint
npm run test --workspace=@repa/web
npm run build --workspace=@repa/web
npm test
```

`apps/web/test` 的 18 个文件中要改的：

- `design-system.test.tsx`：删 `SelectableCard` 的用例；对比度断言保留（见已定 5）；解析 `light-dark()` 取浅色值；字体用例继续生效。
- `learning-space.test.tsx`：`data-variant` 的值。
- `item-form.test.tsx`、`settings-page.test.tsx`：如果 Base UI 的 `role`、名称和 Radix 不同，改组件而不是放宽断言。
- jsdom 缺 `ResizeObserver` 时，在 `test/` 加最小桩。

浏览器走查（内置浏览器，桌面宽度和 1024 宽各一遍），学习者版 `npm run dev:web:learning`，通用版 `npm run dev:web`：

| 页面 | 走什么 |
| --- | --- |
| 学习 | 开始任务、作答、提交、结果；窄窗口里打开辅导 Sheet；单选、多选、表格下拉、代码题 |
| 设置 | 模型连接弹窗、API key 输入、默认模型选择、提示开关（学习者版没有的项跳过）、命令授权单选 |
| 对话（通用版） | 中文输入法选字回车不发送、发送、停止、发送失败后内容还在、分叉 |
| 修改历史（通用版） | 列表、撤回确认弹窗 |
| 选学习空间 | 无最近空间和有最近空间两种布局、选文件夹弹窗、关闭空间 |
| 全局 | Tab 键焦点可见；Esc 逐层退出；系统打开减少动态效果后没有动画；断网下字体仍显示；控制台没有 CSP 报错 |

桌面端共用 `apps/web` 的 Vite 配置，额外运行一次 `npm run dev:desktop` 看启动和字体。

## 考虑过的其他做法

**FF 的 Radix 版。** 原型验证的是它，但 `input-group`、`color-picker`、`ask-user-questions` 两个版本都用 Base UI，选 Radix 版就有两套底层库，违反 `apps/web/AGENTS.md`。

**逐页替换，新旧组件并存。** 单个 PR 小，但并存期间每个页面都混着两种按钮和两套 token，也违反只有一套基础库的约定。

**用 shadcn CLI 安装。** CLI 会递归覆盖同名文件、改写内容，review 时看不出和上游差在哪，还要从外部拉取和执行工具。手工按固定提交复制，差异可以逐文件核对。

**把 FF 全部组件都引入。** 大部分没有调用方，`input-message`、`chat-message` 还会带入 `pdfjs-dist`。只取用得到的。

**强行让每个旧组件都对上一个 FF 组件。** Card、RadioGroup、SelectionButton、Progress、Sheet、MessageBubble 的现有用法 FF 对不上，硬换就要改页面结构，和“只换组件”冲突。这几个保留接口、换底层和令牌，第 2、3 个 PR 改页面时再看去留。

## 验收

- 打开应用，所有页面用的是 FF 的按钮、输入框、弹窗和动效，页面结构和现在一样；学习者版和通用版都能走完上面的路径。
- `apps/web` 的依赖里没有 `radix-ui`，只有 Base UI 一套底层库。
- 断网时界面字体正常显示，中文标题和选中项能看出加粗，控制台没有 CSP 错误。
- 改界面上一句话只需要改 `zh-CN.ts`；`npm run lint` 在组件里新增中文字面量时失败，并报出文件和行号；带占位的版本打不了桌面包。
- `zh-CN.ts` 里每个非占位的值都能在迁移前的源码中找到原文。
- 用中文输入法选字时按回车，不会发送或提交；发送失败后内容还在输入框里；Esc 每次只退一层；系统开启减少动态效果后没有动画；弹层关闭后焦点回到打开它的地方。

## 风险与代价

- **差异面大。** 页面代码多半不改，但基础组件、token 和全部文字都动了。按提交审，第 12、13 个提交是机械替换，可以抽查。
- **视觉回归靠人看。** 取消 2 px 焦点环和品牌紫、正文从 14 px 改 13 px、preflight 打开，都影响现有页面，Vitest 查不出来。
- **Base UI 版未在实际环境跑过。** 原型是 Radix 版。原型待办里要重新验证的滑块这次没有用到；嵌套确认框和菜单在 Esc 和焦点测试里覆盖。
- **上游文件有本地改动。** 升级要对照 README 的清单逐条合并。
- **`motion` 增加包体。** 打包后的增量在 PR 里实测报告。
- **文字检查的盲区。** 纯英文常量查不出。
- **待删的文字暂时还在。** 本 PR 不做 #101 的删字，这些句子会进入字符串文件，直到人改掉。#114 写的 `docs/ui-text.md` 这次也不建，用法先放在 `components/ui/README.md`。

## 已定的问题

2026-11-09 由 Aqua 确定。

1. **侧栏。** 保留现有 `sidebar.tsx`，只换底层和令牌。FF 的侧栏没有图标栏和宽度回调，换上去要改布局。
2. **单选。** 按现有 API 用 Base UI 重写，视觉照 FF，3 处调用不改。
3. **消息输入框。** 这次保留 `InputGroup` 换皮，第 2 个 PR 做底部输入框时再接 `input-message`。
4. **`docs/ui-text.md`。** 不带进这个 PR，见“范围”和“字符串文件”。
5. **控件边界对比度。** 保留测试。`--input` 取至少 3:1 的中性色，输入框类控件的边框改用它，组件结构不变；`docs/design-system.md` 写明这处和组件库原样不同。
