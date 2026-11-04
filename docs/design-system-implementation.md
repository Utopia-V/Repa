# 设计系统实现说明

稳定规则由 [设计系统规范](design-system.md) 持有；本文记录当前实现与接入方式，不作为新增视觉规则的入口。

前端开发执行约束见 [apps/web/AGENTS.md](../apps/web/AGENTS.md)。

## 责任与文件位置

`docs/design-system.md` 定义语义 → `globals.css` 映射主题 → `components/ui` 实现通用组件 → 业务组件组合使用 → 页面布局。

- `globals.css` 内 `--theme-*` 是主题私有色值，仅用于定义语义变量；业务代码禁止引用。
- 公共 CSS variables 按规范中的色彩语义分层。Tailwind 的 `@theme inline` 将其映射为 `bg-primary`、`text-foreground` 等工具类，普通 CSS 可直接使用同名变量。
- 字体、行高、圆角、间距同样由此文件持有，不通过 JavaScript 注入 token，不维护第二份 JSON 色板。
- `components/ui` 使用引入并适配的 shadcn 组件；涉及焦点管理、复合控件与键盘操作的行为复用 Radix。来源与本地适配见[通用组件说明](../apps/web/src/components/ui/README.md)。
- 业务组件持有数据与业务状态，只组合语义组件。例如 `components/domain/conversation-message.tsx` 把发送方映射到 `MessageBubble` 的 variant，不另写气泡颜色。
- 页面负责布局，不持有通用组件样式。

## 当前主题与适配

当前主题为 Ultramarine Workspace。`surface-inset` 映射到 `muted`；`status-complete` 映射到 `--theme-success`，与 `primary` 分开；`border-selected`、`border-error`、`border-complete` 分别映射到 `primary`、`destructive`、`status-complete`；`ring` 映射到中性灰 `--theme-subtle`；`input-focus` 映射到介于 `input` 和 `ring` 之间的 `--theme-control-line-strong`。修改主题时保持语义调用不变，并重新验证背景与前景配对。

规范中的标准名称直接对应 shadcn CSS variables。额外补充边框语义 `border-selected`、`border-error`、`border-complete`，以及 `status-complete`、`status-complete-foreground`、`surface-inset`、`overlay` 这些实际有调用方的语义。

为兼容 shadcn 的 `secondary` variant，`secondary` / `secondary-foreground` 分别是 `accent` / `accent-foreground` 的别名；`popover` / `popover-foreground` 是 `card` / `card-foreground` 的别名。`secondary` 配对仅供基础组件实现 Secondary variant 使用，业务层不得直接作为颜色消费；`popover` 配对用于浮层适配。持续选择的 accent 背景由基础组件决定。没有无调用方的 sidebar、chart 或暗色主题 token。

## 接入范围

Web 只有主应用入口 `apps/web/index.html`，主题由 `apps/web/src/globals.css` 唯一持有，`src/main.tsx` 加载它；主应用 `styles.css` 只保留基于 token 的宿主基础样式。Tailwind 构建集成在 Web 的 Vite 宿主里。Select 使用 Radix 弹层，选中标记为勾选；Button 提供规范中的五种 variant。

Desktop 没有自己的界面：renderer 就是 `apps/web`，由 `apps/desktop/electron.vite.config.ts` 按 Web 自己的 Vite 配置以 desktop 模式构建和开发，所以组件、主题和路由只有 Web 一份。页面运行在桌面端时，preload 在 `window.repaHost` 上提供连接和“在文件夹中显示”，见 `apps/web/src/lib/host.ts`；窗口保留原生标题栏。

开发入口和检查命令见[开发指南](development/README.md)与 [apps/web/AGENTS.md](../apps/web/AGENTS.md)。

## 样式修改入口

```text
docs/design-system.md
  → apps/web/src/globals.css
  → apps/web/src/components/ui
  → apps/web/src/components/domain
  → layouts / pages / features
```

| 修改内容 | 所属位置 |
| --- | --- |
| 语义和可判定约束 | docs/design-system.md |
| 色值、字体尺度、圆角、留白和尺寸 token | globals.css；不新增 tokens.ts |
| 通用 variant / size / hover / active / focus | ui 组件及其 CVA；跨控件的 CSS 由 ui/styles.css 持有，通过 globals.css 加载 |
| 业务状态与基础组件组合 | components/domain |
| 布局、响应式与页面组合 | layouts / pages / features |

## 组件调用边界的落实

- `SelectionButton` 的 CVA 持有持续选择的背景、可见标记与键盘焦点，用于目录、筛选和拓扑节点；图标形态的表面与选中边框也在基础层定义。调用方只传递 selected、图标、标签和布局位置，不通过 className 拼接 accent 或边框状态。
- Standard Card 的 20 px 内距由 Card 根节点统一提供；Header、Content、Footer 不追加水平 padding，页面不得覆盖 Card 内距。
- `SearchInput` 组合 Input 和 Button，要求关联的可见标签；消息输入框按规范的例外不显示标签，以 `aria-label` 提供名称。placeholder 仅作为示例。
- `components/ui/styles.css` 在减少动态效果偏好下关闭基础控件及 Portal 浮层的 animation 和 transition。
- 没有真实调用方的业务组件不预建。

## 参考方式

参考 [LobeHub DESIGN.md](https://github.com/lobehub/lobehub/blob/canary/DESIGN.md) 按语义使用 token、优先复用组件和集中视觉规则的管理方式（查阅于 2026-09-16）。本项目基础组件继续采用 shadcn/Radix，主题使用 CSS variables，不引入 LobeHub 的组件或样式运行时。

## 应用入口与状态

- `src/app.tsx` 管理连接获取、启动重试、连接监听和卸载清理；`components/domain/connection-state.tsx` 呈现启动及连接状态，断线提示位于文档流中，不遮挡页面。`src/routes.tsx` 持有工作台路由，`/` 没有打开空间时进入选空间页；打开了空间、后端装了学习插件时进入学习页，否则进入对话页。
- 调用失败统一经 `src/lib/errors.ts` 的 `describeError` 转成标题与说明，再由 `components/domain/error-notice.tsx` 显示。后端业务错误（`RpcError.data.code`）使用后端返回的中文说明；协议层错误只显示通用说明；`ConnectionError` 表示操作结果未确定，重连后重新读取状态。开发模式下另以等宽小字显示错误码和 `details`。
- 连接断线后会换成新的 `RepaClient`，读取结果又要在页面之间共用，所以状态放在 `src/lib/store.ts` 的 Zustand store 里，由 `hooks/use-app-store.tsx` 的 `StoreProvider` 交给页面；测试每次新建 store。后端数据统一用 `Resource` 表示，重新读取期间保留上一次的 `data`，同一份数据只保留一个进行中的读取，并丢弃先发后到的旧结果。后端不推送设置和空间列表的变化，所以重连和标签页切回可见时都会重新读取。
- 打开的空间、当前会话 id 和侧栏偏好保存在 `localStorage` 的 `repa.web.preferences` 里。后端没有查询当前空间的方法，每次连上都对保存的空间调一次 `space.open`，打开期间 `session.*`、`history.*` 和 `prompt.*` 请求等它结束再发；打不开时清空空间并在选空间页说明原因，连接中断导致的失败保留空间。

## 页面

| 页面 | 文件 | 要点 |
| --- | --- | --- |
| 侧栏 | `layouts/workspace-layout.tsx`、`components/domain/app-sidebar.tsx` | 打开的空间就是“学习空间”这一项，只显示当前这一个；会话列表挂在它下面，运行中不能切换会话，因为运行状态只属于当前会话。“历史”只在打开空间后出现 |
| 选空间 | `pages/learning-space.tsx`、`features/folder-picker.tsx` | 浏览器拿不到本地文件夹的绝对路径，所以由后端 `space.browse` 和 `space.roots` 浏览文件夹，含 `.repa/` 的标“已有空间”。后端关闭空间会中止正在进行的运行，所以运行中不能关 |
| 对话 | `pages/conversation.tsx`、`lib/conversation.ts` | 会话 id 不放进 URL：后端一次只持有一个空间，离开它所在的空间就没有意义。第一次发送才调用 `session.create`，不留空会话。运行中补充的消息只走 `session.steer`，让纠正尽早影响回复 |
| 修改历史 | `pages/history.tsx` | `history.list` 只给来源和时间，所以先取最近 200 条，再从其中最早一条的父提交调用 `history.changes` 取文件。撤回只撤销选中的提交，之后又改过的文件保持现状 |
| 设置 | `pages/settings.tsx`、`features/provider-connect.tsx`、`features/prompt-settings.tsx` | 模型服务商、凭据和默认模型都来自 Pi，前端不维护模型服务商表。开启完全访问前先确认，因为命令不在沙箱里。提示按默认、所有空间、本空间三级合成，本空间这一级协议读不到，由有效内容和上一级的差异推出 |

助手消息由 `components/ui/markdown.tsx` 渲染：只有 http(s) 和 mailto 渲染成链接；图片不加载，显示为指向原地址的链接，避免向第三方暴露访问；代码块用 Shiki 高亮，目前只带 Python、JavaScript、TypeScript、Bash 和 JSON。Agent 调用 `bash` 时的授权对话框由 `features/command-confirmation.tsx` 挂在工作区布局上，离开对话页也能看到。

## 已知限制

- 从用户消息之前分叉（Pi 的“编辑并重发”）没有做：需要上一个条目的位置，会话记录不公开 `parentId`。
- 重新读取会话后，`ask_user` 的提问只能按工具结果的 `details` 还原；中止或断线结束的提问、插件经 `context.ask` 发起的询问，记录里没有题面。要照原样显示，`session.history` 的工具记录需要带 `details`，`details` 也要记下题面。
- `ask_user` 生成的内容块不带 `math`，题面里的公式显示原文。
- 会话列表和修改历史都没有分页；修改历史超过 200 条时注明更早的没有显示。
- 桌面端的系统文件夹选择框还没有接，仍用页面内的选择框。
- Markdown 代码块的复制按钮没有接；长回复逐字增量重新解析的开销没有测量。
