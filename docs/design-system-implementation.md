# 设计系统实现说明

稳定规则由 [设计系统规范](design-system.md) 持有；本文记录当前实现与接入方式，不作为新增视觉规则的入口。

前端开发执行约束见 [apps/web/AGENTS.md](../apps/web/AGENTS.md)。

## 责任与文件位置

`docs/design-system.md` 定义语义 → `globals.css` 映射主题 → `components/ui` 实现通用组件 → 业务组件组合使用 → 页面布局。

- `globals.css` 内 `--theme-*` 是主题私有色值，仅用于定义语义变量；业务代码禁止引用。
- 公共 CSS variables 按规范中的色彩语义分层。Tailwind 的 `@theme inline` 将其映射为 `bg-primary`、`text-foreground` 等工具类，普通 CSS 可直接使用同名变量。
- 字体、行高、圆角、间距同样由此文件持有，不通过 JavaScript 注入 token，不维护第二份 JSON 色板。
- `components/ui` 使用引入并适配的 shadcn 组件；涉及焦点管理、复合控件与键盘操作的行为复用 Radix。
- 业务组件持有数据与业务状态，只组合语义组件。当前 `components/domain/conversation-message.tsx` 把发送方映射到 `MessageBubble` 的 variant，不另写气泡颜色。
- 页面负责布局，不持有通用组件样式。Web 与 Desktop 主应用的启动、失败重试、断线提示和工作台侧栏已接入；其他 Desktop 组件尚未迁移。

## 当前主题与适配

当前主题为 Ultramarine Workspace。`surface-inset` 映射到 `muted`。`status-complete` 映射到 `primary`；`border-selected`、`border-error`、`border-complete` 分别映射到 `primary`、`destructive`、`status-complete`；`ring` 映射到中性灰 `--theme-subtle`；`input-focus` 映射到介于 `input` 和 `ring` 之间的 `--theme-control-line-strong`。修改主题时保持语义调用不变，并重新验证背景与前景配对。

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
| 业务状态与基础组件组合 | domain/app-sidebar.tsx、connection-state.tsx、conversation-message.tsx、error-notice.tsx |
| 布局、响应式与页面组合 | layouts / pages / features |

`SelectionButton` 统一持续选择的背景、可见标记与键盘焦点，用于目录、筛选和拓扑节点；`SearchInput` 组合 Input 和 Button，页面不再通过子元素选择器改写输入框圆角。`ConversationMessage` 将 sender 映射到 `MessageBubble` 的 variant；通用气泡视觉由 ui 持有。没有真实调用方的业务组件不预建。

Desktop renderer 在 `apps/desktop/src/renderer/src/` 持有自己的 `globals.css`、基础组件源码和业务组合，当前只引入主应用与侧栏实际使用的组件。主题语义和侧栏交互以 Web 当前实现为基准；连接继续通过 preload 的 `getConnection` 获取，路由继续使用 Memory Router，窗口保留原生标题栏。Desktop 的 Tailwind 插件与路径别名由 `electron.vite.config.ts` 提供，`src/renderer/src/main.tsx` 加载主题和宿主样式。两端没有共享组件包，后续改动共同规则时需核对对应实现。

Desktop 验证入口为 `npm run check --workspace=@repa/desktop`、`npm run test --workspace=@repa/desktop` 和 `npm run build --workspace=@repa/desktop`；`apps/desktop/test/app.test.tsx` 覆盖启动与重连、Memory Router 导航、折叠栏和窄窗口抽屉。

## 参考方式

参考 [LobeHub DESIGN.md](https://github.com/lobehub/lobehub/blob/canary/DESIGN.md) 按语义使用 token、优先复用组件和集中视觉规则的管理方式（查阅于 2026-09-16）。本项目基础组件继续采用 shadcn/Radix，主题使用 CSS variables，不引入 LobeHub 的组件或样式运行时。

## 组件调用边界的落实

- `SelectionButton` 的 CVA 持有持续选择外观；图标形态的表面与选中边框也在基础层定义。调用方只传递 selected、图标、标签和布局位置，不通过 className 拼接 accent 或边框状态。
- Standard Card 的 20 px 内距由 Card 根节点统一提供；Header、Content、Footer 不再追加水平 padding，页面不得覆盖 Card 内距。
- `SearchInput` 要求 label，并使用关联的可见标签；消息输入框按规范的例外不显示标签，以 `aria-label` 提供名称。placeholder 仅作为示例。
- `components/ui/styles.css` 在减少动态效果偏好下关闭基础控件及 Portal 浮层的 animation 和 transition。

## 主应用入口

`src/app.tsx` 继续管理连接获取、启动重试、连接监听和卸载清理；不在 UI 迁移中改变协议或客户端生命周期。`components/domain/connection-state.tsx` 组合 Card、Button 与 ErrorNotice 呈现启动及连接状态，`workspace-layout.tsx` 组合应用侧栏与路由出口。`src/routes.tsx` 持有工作台路由。

调用失败统一经 `src/lib/errors.ts` 的 `describeError` 转成标题与说明，再由 `components/domain/error-notice.tsx` 组合 `StatusNotice` 显示。后端业务错误（`RpcError.data.code`）直接使用后端返回的中文说明；协议层错误只显示通用说明，不展示英文原文；`ConnectionError` 提示操作结果未确定，重连后重新读取状态。开发模式下另以等宽小字显示错误码和 `details`。新底座不再提供业务请求编号，排查以错误码为准。

主应用 `src/main.tsx` 加载 globals.css；旧 styles.css 的硬编码配色、渐变、卡片阴影和按钮外观已移除。断线提示位于文档流中，保留路由内容并避免遮挡页面。工作台默认进入 Learning Space；Web 显示最近空间列表，Desktop 仍为材料选择页。

## 应用状态

页面要读后端数据，而连接会在断线后换成新的 `RepaClient`，读取结果也需要在多个页面之间共用，因此 Web 用一个 Zustand store 持有这些状态。`src/lib/store.ts` 的 `createAppStore()` 创建 vanilla store，`src/main.tsx` 创建实例并传给 `App`；`hooks/use-app-store.tsx` 的 `StoreProvider` 把它交给路由内的页面，页面通过 `useAppStore(selector)` 选取需要的字段。测试每次新建 store，不共享模块级单例。

从后端读取的数据统一用 `Resource` 表示：`status` 为 idle、loading、ready 或 error，重新读取期间保留上一次的 `data`，界面不会回到空白。同一份数据只保留一个进行中的读取，并以序号丢弃先发后到的旧结果。`App` 连接成功后调用 `setClient`，store 换用新连接并重新读取已经读过的数据；标签页切回可见时 `StoreProvider` 也会重新读取，因为后端不推送设置和空间列表的变化。修改类操作（目前是 `openSpace`）把失败抛给调用页面，由页面在本地状态里显示进行中与失败。

目前 store 持有最近空间（`space.list`，最新的在前）、模型提供方（`model.providers`）、模型列表（`model.list`）、默认模型（`model.getDefault`）、当前空间的会话列表（`session.list`，换空间时清空）、本页面打开的空间、当前会话、待回答的命令授权、进行中的模型登录和侧栏偏好；只有侧栏偏好保存在浏览器里。后端没有查询当前空间的方法，`setClient` 换连接后对原来的空间再调一次 `space.open`：同一个空间后端直接返回，后端重启过则重新打开；打不开时清空空间，对话页回到空间选择。会话列表依赖打开的空间，不随其他数据在换连接时直接重读，而是在空间重新打开之后再读。`setClient` 同时在新连接上订阅 `session.event` 和 `confirm.request`，旧连接上的授权请求随断线由后端取消，store 一并清空。


## 工作台侧栏

- `components/ui/sidebar.tsx` 从 shadcn 官方 `new-york-v4/sidebar.json` 引入本次使用的 Provider、Sidebar、Trigger、Rail、Header、Content、Footer、Group、Menu 与 Submenu 组合；未引入没有调用方的 Input、Skeleton、Tooltip 和菜单附件。
- `SidebarRail` 是侧栏边缘的 16 px 手势条，点击切换展开/收起，悬停显示 2 px 中性 `border` 竖线；支持拖动调整宽度、双击重置，键盘方向键调整、Home 重置、Enter/空格切换；上游的 offcanvas 类保留但当前未被使用。
- `layouts/workspace-layout.tsx` 通过 SidebarProvider 组合应用侧栏、打开入口和空白路由出口。桌面展开宽度 280 px，收起为 56 px 常驻图标栏（`collapsible="icon"`）；移动端由官方 `useIsMobile` 与 Sheet 切换为侧边面板。桌面折叠栏自带展开入口，工作区只在移动端渲染浮动打开按钮。桌面可拖动至 200 px—480 px，最大不超过视口的 40%；拖至最小宽度以下收起，折叠时向外拖至 200 px 展开阈值才展开，小幅拖动保持折叠；展开使用完整过渡并结束本次拖动。桌面的展开状态和宽度由 Zustand store 的 `persist` 写入 `localStorage`（键 `repa.web.preferences`，只含侧栏偏好），刷新后保留；存储不可用时退回默认展开、默认宽度，格式不对的项逐项回到默认值；移动端抽屉每次从关闭开始，不保存。拖动期间用 80 ms 短过渡平滑调整宽度，跨过收起阈值时恢复完整折叠动画，取消、失去指针捕获或卸载时清理拖动状态。
- 折叠栏沿用 SidebarMenuButton 的 token 与交互状态，通过 `sr-only` 保留标签的可访问名称，并用 `title` 提供图标提示。侧栏支持拖动调宽、收起与展开；移动端复用 Sheet 的关闭、Escape 和焦点恢复行为。
- Web 的 `components/domain/app-sidebar.tsx` 组合 Learning Space 和 Settings 两个栏目；打开空间后，它下面的二级菜单项显示这个空间的文件夹名（悬停显示完整路径），点击进入对话页，在对话页时为当前项。后端一次只持有一个空间，所以只列当前打开的这一个，最近空间仍在 Learning Space 页选择；整页刷新后页面不知道当前空间，这一项随之消失。侧栏收起为图标栏时二级菜单隐藏。打开空间后，主导航下方的“会话”组由 `components/domain/session-list.tsx` 列出这个空间的会话，最近有消息的在前，名称取会话名，没有时取第一条消息的开头，悬停显示全文；点击打开该会话并进入对话页，在对话页时正在查看的会话为当前项。运行中其他会话不能点，因为运行状态只属于当前会话，切走后无法再查询。会话很多时随侧栏滚动，还没有分页；收起为图标栏时整组隐藏。Settings 目前有模型设置和命令授权，见下方“设置页”。Desktop 的 Settings 仍是空页面。两端都不再显示 Chat、示例会话、Goals、Wiki、Sources、History 或本地空间提示卡，布局不再保存会话展开状态。
- `/` 重定向到 `/learning-space`，未知地址显示未找到页面，两者共用工作台布局。Desktop 另有内容为空的 `/settings`。
- Web 的 `test/sidebar.test.tsx` 验证栏目、默认页、会话列表的顺序、切换与运行中禁用、移动抽屉的导航与焦点恢复、图标栏、拖动调宽和刷新后保留侧栏状态；`test/app.test.tsx` 验证连接生命周期及 Desktop 导航；`test/store.test.ts` 验证读取去重、重连后重新读取、旧结果丢弃，以及侧栏偏好的保存、格式校验和存储不可用时的退路。

## Learning Space 页面

Web 的 `pages/learning-space.tsx` 按有没有最近空间分成两种布局。第一次使用时没有可以继续的空间，页面只显示引导和一个主按钮“选择文件夹”，在工作区里水平、垂直居中，底部留白略多，视觉重心稍高于几何中心；有最近空间的布局保持靠上，列表长短变化时标题不跟着移动；有最近空间时，继续学习是主要任务，页头右侧的“选择其他文件夹”退为 Outline，下面是“最近打开”区块。最近列表读完之前只显示读取提示，不先显示首次引导；读取失败时在区块内显示原因和重试，此时“选择文件夹”回到 Primary，仍可通过选择器进入。列表每一项用整行 `SelectionButton` 显示文件夹名和完整路径，本页面打开的空间处于选中状态；点击后该项显示“正在打开…”，其他项暂时禁用，失败原因显示在区块标题下方。窄屏下页头按钮移到描述下方并撑满宽度。选择框挂在两种布局之外，读取完成引起布局切换时不会被卸载。打开空间后进入对话页。后端只记录最近空间的路径，没有打开时间，也不标记已删除的文件夹，这类文件夹在打开时才报告不存在。原材料选择组件只把文件暂存在页面内存，新底座也没有上传入口，已从 Web 移除。`test/learning-space.test.tsx` 覆盖两种布局、按钮主次、列表、打开后进入对话、打开失败和读取失败重试。

浏览器拿不到本地文件夹的绝对路径，所以页面上的“选择文件夹”由后端浏览文件夹：`features/folder-picker.tsx` 在 Dialog 中调用 `space.browse` 从用户目录开始，一层层点进子文件夹。含 `.repa/` 的文件夹标“已有空间”，当前文件夹底部只有一个“打开”，调用 `space.open`；当前文件夹还不是空间时提示会在里面保存 Repa 的数据，第一次打开时由后端建立 `.repa/`。走到盘的根目录后，“上一级”改为显示 `space.roots` 返回的磁盘列表，Windows 用户由此换到其他盘；mac/Linux 只有 `/`，到根目录后“上一级”禁用。浏览结果只属于当次选择，不进入 store 的共享数据；每次导航后焦点移到当前位置标题，读取失败时停留在原位置并显示原因。`test/folder-picker.test.tsx` 用模拟的 Windows 盘符布局覆盖浏览、已有空间标记、打开、换盘、无权限和打开失败。Desktop 计划改用系统文件夹选择框，随 Desktop 跟进 Web 时接入。

Desktop 仍由 `pages/learning-space.tsx` 居中显示 `components/domain/learning-upload.tsx`：它负责材料拖拽、多文件选择、去重和移除，相邻 CSS 只使用语义 token；“开始学习”不触发上传，保持禁用。Web 定型后 Desktop 再随之调整。

## 对话页

Web 的 `pages/conversation.tsx` 挂在 `/conversation`，没有打开空间时重定向回 `/learning-space`。会话 id 不放进 URL：后端一次只持有一个活动空间，刷新后页面也不知道当前空间。进入页面时读取 `session.list` 中最近有消息（`updatedAt`）的会话及其 `session.history`，在侧栏的会话列表里可以切换到其他会话；空间里还没有会话，或点了“新会话”，都等第一次发送才调用 `session.create`，不留下空会话。

输入框下方的 Ghost 按钮显示当前会话的模型。Pi 把模型保存在会话里，已建立的会话一直沿用自己的模型，默认模型只决定新会话用哪个；所以这里显示 `session.list` 给出的会话模型，还没建立的会话显示选中的或默认模型。点击打开 `features/model-picker.tsx` 的会话版本，只列已连接提供方的模型：已建立的会话调用 `session.setModel`，还没建立的记下来，在 `session.create` 时传入；两种都不改默认模型。模型的提供方没有连接时（例如之前的提供方已断开），按钮旁提示发送会失败。运行中不能换。

显示内容由 `lib/conversation.ts` 转换：`historyItems` 把会话记录转成用户消息、助手消息、工具调用、错误和“已停止”标记，提示、view、用量等运行细节不显示；`applyEvent` 按 `session.event` 实时更新，`textDelta` 拼到正在生成的助手消息上，完整的 `message` 覆盖拼接结果，工具调用按 `callId` 更新状态。运行结束（`runEnd` 或 `session.send` 返回）后重新读取会话记录，以记录替换实时内容。store 只处理当前会话的事件。

`session.send` 要等整次运行结束才返回，运行中发送按钮换成“停止”，调用 `session.abort`。模型出错和取消已写进会话记录，由记录显示；没写进记录的失败（例如连接中断）显示在输入框上方，消息内容退回输入框。进入对话页时读取 `model.getDefault`、`model.list` 和 `model.providers`；当前会话还没有模型且默认模型为 `null`（没有可用模型），或发送时后端报 `model_required`，输入框上方改为显示“还没有可用的模型”和去设置页的链接，不再重复显示错误。连接中断时运行状态无法查询，从空闲开始，收到事件再更新。

页面占满一屏，只有对话记录区滚动，输入框留在底部。顶栏只占一行，铺满工作区宽度：左侧只显示空间名称，过长时截断，悬停显示完整路径；“新会话”是工具栏里的轻量操作，用 Ghost 按钮靠右；对话记录滚动离开顶部后才出现分隔线；移动端左侧让出浮动的导航按钮。对话记录停在底部附近时跟随新内容，往上翻看时不打断。`components/domain/message-composer.tsx` 用 `InputGroup` 把文本框和发送／停止按钮合成一个框（两个按钮都是带可访问名称的图标按钮，发送用 Primary，停止用 Outline），聚焦时边框加深为 `input-focus` 色并加阴影，不加粗，文本框随内容增高，最高 240px 且不超过视口高度的 35%，超出后在框内滚动，长行在框内折行、不撑宽页面；Enter 发送、Shift+Enter 换行，输入法确认候选词的 Enter（`isComposing` 或 Safari 的 `keyCode` 229）不发送；`components/domain/tool-activity.tsx` 用图标加文字显示工具状态，内置工具显示动作名称。用户消息按原文显示并保留换行；助手消息由 `components/ui/markdown.tsx` 渲染成 Markdown，正在生成的那条传 `streaming`。

`Markdown` 用 react-markdown 解析，插件分工如下：`remark-gfm` 负责表格、删除线和任务列表；`remark-cjk-friendly` 及其删除线插件让中文标点旁的 `**`、`~~` 生效；`remark-math-extended` 识别 `$…$`、`$$…$$`、`\(…\)`、`\[…\]`，由 `rehype-katex` 渲染，写错的公式显示原文。单个 `$` 也按公式解析，“$5 和 $10” 这类金额会被误认，学习场景下接受这个代价。单个 `~` 不算删除线，`20~25` 保持原样。生成中先经 `remend` 补全没写完的加粗、行内代码、链接和 `$`/`$$` 公式；`\[…\]` 不在它的补全范围内，结束符到达前显示 TeX 原文。组件用 `memo` 包住，文字没变的消息不重新解析；只有正在生成的那条随增量重新解析，长回复的开销尚未单独测量。

元素样式由组件内的 `components` 映射到 token，不使用 typography 插件：Markdown 标题整体下移两级（`#` 渲染为 h3），字号不超过 Body Large；代码使用 Code token 和 `font-mono`（`globals.css` 把它映射到 `--font-code`），代码块和表格、公式块在各自区域内横向滚动。原始 HTML 按文本显示。只有 http(s)、mailto 渲染成新标签页链接，相对路径只显示文字；图片不加载，显示为指向原地址的“[图片：说明]”链接，避免向第三方暴露访问并避免显示模型编造的地址。代码块用 Shiki 按标注的语言高亮，目前只带 Python（py）、JavaScript（js）、TypeScript（ts）、Bash（sh）和 JSON，其他语言和没标语言的代码块按纯文本显示；代码块统一是深色底，语法颜色来自 Shiki 内置的 Catppuccin Mocha 主题，底色、正文和语言标签走 Code token；行内代码保持浅色样式；高亮出错时保留原样的代码块。复制按钮尚未接入。

Agent 调用 `bash` 时后端发出 `confirm.request`。`features/command-confirmation.tsx` 挂在工作区布局上，离开对话页也能看到，显示命令和“拒绝／允许”，关闭对话框按拒绝回复；登录用的 input、select、display 请求由设置页的登录流程处理，没有进行中的登录时 store 直接回复取消，避免后端停在等待上。后端取消运行时不撤回已发出的授权请求，`sendMessage` 结束时清空。

`test/conversation.test.ts` 覆盖记录与事件的转换，`test/conversation-store.test.ts` 覆盖按最后消息打开会话、切换会话与运行中不切换、给新会话或已建立的会话换模型、换空间清空会话列表、延迟建立会话、实时显示与运行结束后替换、失败分类、停止、授权排队和重连后重新打开空间，`test/conversation-page.test.tsx` 覆盖页面的发送、输入法回车、停止、失败退回输入框、授权对话框、两种发送者的显示方式以及会话模型的显示与更换，`test/markdown.test.tsx` 覆盖 Markdown 元素、两种公式写法、链接与图片限制和生成中的语法补全。

## 设置页

Web 的 `pages/settings.tsx` 挂在 `/settings`，目前有模型设置和命令授权。模型设置的数据全部来自 Pi：提供方目录、凭据和默认模型都由底座转发，前端不维护提供方表。

- “默认模型”显示 `model.getDefault` 的结果，即新会话不指定模型时使用的模型：Pi 设置里的默认模型，没设置时是第一个可用模型。它的提供方没有连接时在名称下提示发送会失败。“更换”打开 `features/model-picker.tsx`，只列已连接提供方的模型；一个提供方可能有几百个模型，所以用搜索加列表，选中后调用 `model.setDefault`。
- “模型提供方”列出 `configured` 的提供方及凭据类型。`stored` 的可以“断开”（`auth.logout`）；环境变量或 `models.json` 提供的凭据标“由环境变量或配置文件提供”，不显示断开。还没有连接时“添加提供方”是主按钮。
- `features/provider-connect.tsx` 是连接对话框：先搜索选择提供方，有多种方式时再选“用账号登录”或“填写 API key”，只能在 Repa 之外配置的方式只给说明。key 用密码输入框，经 `auth.setKey` 保存；后端返回 `requires_interactive_login`（例如 Amazon Bedrock 还要选认证方式）时自动改走 `auth.login`。账号登录和这类 key 登录过程中，后端发来的 `display` 显示为说明和“打开链接”（新标签页），收到即回复，后端不用等用户点；`input`（`secret` 时为密码框）和 `select` 在对话框里排队回答。底座把选项写成 message 里的“id：名称 — 说明”，每项都能对上时按钮直接显示这一行。关闭对话框即取消：未回答的请求回复 `null`，之后的失败不再提示；只在浏览器里等待回调、没有可回答请求的步骤要等后端自己结束。登录失败显示原因，可以重试。
- “命令授权”读写应用设置里的 `commandPolicy`（`settings.get`／`settings.set`），store 只取这一项，最近空间和提示覆盖由各自入口读取。“每次询问”（`ask`）时 Agent 每次调用 `bash` 都弹出对话页的授权对话框；“完全访问”（`fullAccess`）时直接运行，没有发起连接的后台命令也会运行，而询问模式下它们会被阻止。命令不在沙箱里，可能改动学习空间之外的文件，这些改动不在空间历史的撤回范围内，所以选完全访问时先用对话框说明后果，确认后才保存；改回询问没有风险，选中即保存。后端在每次命令执行前读取设置，保存后从下一条命令起生效，正在运行的会话也一样；已经弹出的授权对话框不会因此自动允许。设置对所有空间生效，保存失败时显示原因并保留原来的选项。
- `test/settings-page.test.tsx` 用模拟后端覆盖列表与环境变量凭据、搜索后填 key 连接和断开、key 不够时改走交互登录、账号登录的链接与选项及关闭取消、登录失败重试、选择默认模型，以及开启完全访问前的确认与取消、改回询问、保存失败；`test/conversation-page.test.tsx` 覆盖没有可用模型时的引导。真实 Pi 提供方的 Anthropic 账号登录（选择方式、链接、授权码输入、取消）和 Amazon Bedrock 的 key 回退已在浏览器中走到授权前一步，没有用真实账号完成登录。
