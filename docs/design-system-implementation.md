# 设计系统实现说明

稳定规则由 [设计系统规范](design-system.md) 持有；本文记录当前实现与接入方式，不作为新增视觉规则的入口。

前端开发执行约束见 [apps/web/AGENTS.md](../apps/web/AGENTS.md)。

## 责任与文件位置

`docs/design-system.md` 定义语义 → `globals.css` 映射主题 → `components/ui` 实现通用组件 → 业务组件组合使用 → 页面布局。

- `globals.css` 内 `--theme-*` 是主题私有色值，仅用于定义语义变量；业务代码禁止引用。
- 公共 CSS variables 按规范中的色彩语义分层。Tailwind 的 `@theme inline` 将其映射为 `bg-primary`、`text-foreground` 等工具类，普通 CSS 可直接使用同名变量。
- 字体、行高、圆角、间距同样由此文件持有，不通过 JavaScript 注入 token，不维护第二份 JSON 色板。
- `components/ui` 使用引入并适配的 shadcn 组件；涉及焦点管理、复合控件与键盘操作的行为复用 Radix。
- 业务组件持有数据与业务状态，只组合语义组件。当前 `components/domain/knowledge-card.tsx` 组合 `SelectableCard` 与 `Badge`，不另写卡片颜色。
- 页面负责布局，不持有通用组件样式。Web 与 Desktop 主应用的启动、失败重试、断线提示和工作台侧栏已接入；其他 Desktop 组件尚未迁移。

## 当前主题与适配

当前主题为 Ultramarine Workspace。`surface-inset` 映射到 `muted`。`status-complete` 映射到 `primary`；`border-selected`、`border-error`、`border-complete` 分别映射到 `primary`、`destructive`、`status-complete`；`ring` 映射到中性灰 `--theme-subtle`。修改主题时保持语义调用不变，并重新验证背景与前景配对。

规范中的标准名称直接对应 shadcn CSS variables。额外补充边框语义 `border-selected`、`border-error`、`border-complete`，以及 `status-complete`、`status-complete-foreground`、`surface-inset`、`overlay` 这些实际有调用方的语义。

为兼容 shadcn 的 `secondary` variant，`secondary` / `secondary-foreground` 分别是 `accent` / `accent-foreground` 的别名；`popover` / `popover-foreground` 是 `card` / `card-foreground` 的别名。`secondary` 配对仅供基础组件实现 Secondary variant 使用，业务层不得直接作为颜色消费；`popover` 配对用于浮层适配。持续选择的 accent 背景由基础组件决定。没有新增无调用方的 sidebar、chart 或暗色主题 token。

旧 `primary-hover`、`primary-active`、`surface-selected` 和多级正文灰度已取消；hover/active 的视觉变化由组件从语义 token 派生。同一个语义只保留一个选择入口，不因数值暂时相同而合并不同责任。

## 主应用接入范围

Web 仅保留主应用入口 `apps/web/index.html`，主题由 `apps/web/src/globals.css` 唯一持有。Select 使用 Radix 弹层，当前选中标记为勾选。Button 提供规范中的五种 variant；未使用的上游 `link` variant 已移除。

运行 `npm run dev:web` 并访问主应用。Tailwind 构建集成在 Web Vite 宿主；主题由主应用入口引入；主应用 styles.css 仅保留基于 token 的宿主基础样式。

`npm run check --workspace=@repa/web`、`npm run test --workspace=@repa/web`、`npm run build --workspace=@repa/web` 验证类型、组件与构建。`apps/web/test/design-system.test.tsx` 覆盖主题对比度、选择/焦点独立性、按钮提交语义、进度可访问值以及弹窗焦点恢复。浏览器验收还需检查移动端、键盘 ring 和更换完成色后主要行动保持原色。

实现来源见 [通用组件说明](../apps/web/src/components/ui/README.md)。

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
| 业务状态与基础组件组合 | domain/knowledge-card.tsx、conversation-message.tsx、topology-node.tsx |
| 布局、响应式与页面组合 | layouts / pages / features |

`SelectionButton` 统一持续选择的背景、可见标记与键盘焦点，用于目录、筛选和拓扑节点；`SearchInput` 组合 Input 和 Button，页面不再通过子元素选择器改写输入框圆角。`ConversationMessage` 将 sender 映射到 `MessageBubble` 的 variant；通用气泡视觉由 ui 持有。没有真实调用方的业务组件不预建。

Desktop renderer 在 `apps/desktop/src/renderer/src/` 持有自己的 `globals.css`、基础组件源码和业务组合，当前只引入主应用与侧栏实际使用的组件。主题语义和侧栏交互以 Web 当前实现为基准；连接继续通过 preload 的 `getConnection` 获取，路由继续使用 Memory Router，窗口保留原生标题栏。Desktop 的 Tailwind 插件与路径别名由 `electron.vite.config.ts` 提供，`src/renderer/src/main.tsx` 加载主题和宿主样式。两端没有共享组件包，后续改动共同规则时需核对对应实现。

Desktop 验证入口为 `npm run check --workspace=@repa/desktop`、`npm run test --workspace=@repa/desktop` 和 `npm run build --workspace=@repa/desktop`；`apps/desktop/test/app.test.tsx` 覆盖启动与重连、Memory Router 导航、折叠栏和窄窗口抽屉。

## 参考方式

参考 [LobeHub DESIGN.md](https://github.com/lobehub/lobehub/blob/canary/DESIGN.md) 按语义使用 token、优先复用组件和集中视觉规则的管理方式（查阅于 2026-09-16）。本项目基础组件继续采用 shadcn/Radix，主题使用 CSS variables，不引入 LobeHub 的组件或样式运行时。

## 组件调用边界的落实

- `SelectionButton` 的 CVA 持有持续选择外观；图标形态的表面与选中边框也在基础层定义。`TopologyNode` 仅传递 selected、图标、标签和布局位置，不通过 className 拼接 accent 或边框状态。
- Standard Card 的 20 px 内距由 Card 根节点统一提供；Header、Content、Footer 不再追加水平 padding，页面不得覆盖 Card 内距。
- `SearchInput` 要求 label，并使用关联的可见标签；消息输入区也提供可见 label。placeholder 仅作为示例。
- `components/ui/styles.css` 在减少动态效果偏好下关闭基础控件及 Portal 浮层的 animation 和 transition。

## 主应用入口

`src/app.tsx` 继续管理连接获取、启动重试、连接监听和卸载清理；不在 UI 迁移中改变协议或客户端生命周期。`components/domain/connection-state.tsx` 组合 Card、Button、StatusNotice 呈现启动及连接状态，`workspace-layout.tsx` 组合应用侧栏与路由出口。`src/routes.tsx` 持有工作台路由。

主应用 `src/main.tsx` 加载 globals.css；旧 styles.css 的硬编码配色、渐变、卡片阴影和按钮外观已移除。断线提示位于文档流中，保留路由内容并避免遮挡页面。工作台默认进入 Learning Space 材料选择页，真实学习流程后续接入。


## 工作台侧栏

- `components/ui/sidebar.tsx` 从 shadcn 官方 `new-york-v4/sidebar.json` 引入本次使用的 Provider、Sidebar、Trigger、Rail、Header、Content、Footer、Group、Menu 与 Submenu 组合；未引入没有调用方的 Input、Skeleton、Tooltip 和菜单附件。
- `SidebarRail` 是侧栏边缘的 16 px 手势条，点击切换展开/收起，悬停显示 2 px 中性 `border` 竖线；支持拖动调整宽度、双击重置，键盘方向键调整、Home 重置、Enter/空格切换；上游的 offcanvas 类保留但当前未被使用。
- `layouts/workspace-layout.tsx` 通过 SidebarProvider 组合应用侧栏、打开入口和空白路由出口。桌面展开宽度 280 px，收起为 56 px 常驻图标栏（`collapsible="icon"`）；移动端由官方 `useIsMobile` 与 Sheet 切换为侧边面板。桌面折叠栏自带展开入口，工作区只在移动端渲染浮动打开按钮。桌面可拖动至 200 px—480 px，最大不超过视口的 40%；拖至最小宽度以下收起，折叠时向外拖至 200 px 展开阈值才展开，小幅拖动保持折叠；展开使用完整过渡并结束本次拖动。宽度只存于内存，拖动期间用 80 ms 短过渡平滑调整宽度，跨过收起阈值时恢复完整折叠动画，取消、失去指针捕获或卸载时清理拖动状态。
- 折叠栏沿用 SidebarMenuButton 的 token 与交互状态，通过 `sr-only` 保留标签的可访问名称，并用 `title` 提供图标提示。侧栏支持拖动调宽、收起与展开；移动端复用 Sheet 的关闭、Escape 和焦点恢复行为。
- `components/domain/app-sidebar.tsx` 仅组合 Learning Space 和 Settings 两个栏目。Learning Space 位于上方，Settings 位于底部；不再显示 Chat、示例会话、Goals、Wiki、Sources、History 或本地空间提示卡。布局不再保存会话展开状态，已移除示例导航数据文件。
- `/` 重定向到 `/learning-space`，显示材料选择组件；`/settings` 内容暂时为空。两者共用工作台布局，未知地址显示未找到页面。
- `test/sidebar.test.tsx` 验证两个栏目、默认页、导航历史、移动抽屉与焦点恢复、图标栏和拖动调宽；`test/app.test.tsx` 验证连接生命周期及 Desktop 导航。

## Learning Space 材料选择

Web 和 Desktop 均由 `pages/learning-space.tsx` 负责居中布局，`components/domain/learning-upload.tsx` 负责材料拖拽、多文件选择、去重和移除，相邻 CSS 仅使用语义 token。默认路由为 `/learning-space`，侧栏通过 Learning Space 进入材料选择页。书本使用现有 lucide-react 的 BookOpen 图标，主要行动复用 Button。材料暂存在页面内存，离开页面后清空；上方拖拽框独立承担文件选择，仅在文件输入具有 `:focus-visible` 时显示容器焦点环，鼠标点击不额外描边。“开始学习”是进入学习页面的入口，不触发文件选择或上传；学习页面暂不实现，按钮保持禁用。
