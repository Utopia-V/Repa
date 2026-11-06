# Web 前端开发规范

适用于 `apps/web/` 及其子目录，与[根目录约束](../../AGENTS.md)共同生效；不规定 Desktop 的目录和实现方式。下文 `src/` 路径均相对于本目录，命令在仓库根目录运行。

## 开发前阅读

- [设计系统规范](../../docs/design-system.md)：稳定设计规则；尺寸、组件用途、状态和可访问性以此为准，不在本文件复制数值表。
- [设计系统实现说明](../../docs/design-system-implementation.md)：当前接入范围、文件职责和主题加载方式。
- [开发指南](../../docs/development/README.md)：Web 宿主、后端接入与工程边界。
- 修改基础组件时核对[通用组件说明](src/components/ui/README.md)中的上游来源与本地适配。

## 样式与组件归属

- 样式链路为 `docs/design-system.md` → `src/globals.css` → `src/components/ui` → `src/components/domain` → 页面或 feature；页面或 feature 位于组件的调用层，不反向定义组件视觉。
- 优先复用 `src/components/ui` 中已有的 shadcn 组件；基础组件存在 variant 或 size 时使用 CVA 管理。
- 颜色必须使用 semantic design tokens，不直接写品牌色或中性色 HEX/RGB，不引用主题私有变量。`src/globals.css` 是 token 的唯一真实来源，不另建 `tokens.ts` 或 JSON 色板。
- 不新增任意圆角、字号或非 spacing scale 间距；布局尺寸、拓扑坐标和图标尺寸不冒充留白 token。
- 通用 hover、active、focus、disabled 等视觉行为修改基础组件，不通过逐页 CSS、子元素选择器或 className 覆盖。
- `src/components/domain` 组合基础组件和业务状态，将 selected、completed、current、error 等映射到已有语义，不重新定义基础视觉语言；不依赖页面 CSS 才能正确显示。
- 页面级样式主要负责 layout、响应式、组合和页面间距；颜色、边框色、圆角、阴影、字号与组件状态优先由组件持有。允许使用 Tailwind，使用位置由职责决定。
- 新增 token 前先确认现有 token 无法表达该语义，说明实际调用方与允许使用范围，并先修订规范。

## 组件实现与交互

- 基础组件不持有学习业务数据；业务组件通过 props 表达业务状态；页面或 feature 负责数据接入和组合，不为每个页面复制基础组件。
- 复用现有 shadcn/Radix 的焦点管理、键盘操作和复合控件行为。更新上游源码前核对本地适配，不直接覆盖项目 variant、尺寸和可访问性规则。
- 同一 size 下各 Button variant 共享几何与排版；Disabled 是状态。默认 Button 不提交表单，提交入口显式使用 `type="submit"`。
- 重要状态提供非颜色视觉提示，同时提供对应的原生或 ARIA 状态。Selected 与 Focus 独立，不以选中标记替代焦点提示。
- 输入控件使用可见 label（对话输入框的例外见设计系统规范）；错误说明关联输入。图标按钮提供可访问名称；交互组件支持键盘操作。
- 业务组件、页面和 feature 的 `className` 仅用于布局、定位、响应式及基础组件明确允许的 composition spacing；不得覆盖 variant、颜色、边框或 ring、圆角、阴影、排版和交互状态。Card 内距由基础组件 size / variant 持有；响应式和页面 CSS 不豁免限制。具体范围以 `docs/design-system.md` 为准。
- 组件不得依赖调用页面的 CSS 才能正确显示，不维护第二套 token 展示值。
- 新增或修改界面需处理窄屏、内容换行、文字放大和减少动态效果偏好；不得通过缩小正文或禁用缩放隐藏布局问题。

## 数据与接入边界

- 界面是学习状态的视图：呈现后端算出的进度与状态，不另加与学习无关的指标。作答前不显示知识点、进度只在新课显示等规则见[学习契约](../../docs/development/learning-protocol.md#状态与方法)。
- 学习页面目前为学习插件写定，结构不约束以后。
- 后端能力通过现有 `@repa/base/client` 与 `@repa/base/protocol` 接入；组件层不自行实现协议、持久化或模型调用。
- 沿用已有路由、启动和连接入口，不另建连接或配置机制。
- 新依赖先核对锁定版本和已有能力，不引入第二套基础 UI 库或主题运行时。

## 界面文字与基础组件

- 界面文字放在字符串文件里，组件只引用键；新键由人书写，Agent 只留占位，见[约定](../../.agents/notes/proposed/architecture/2026-11-06-ui-strings-and-components.md)。
- 输入法选字、Esc、失败时保留输入、减少动效和焦点恢复由基础组件实现，做不到时改基础组件。
- 模型或课程生成的内容按设计 token 渲染；课程自带组件的接入同见上述约定。

## 开发与验证

- 开发：运行 `npm run dev:web`，通过主应用验证界面。
- 实现变更运行以下检查；只改文档时不必构建。

```sh
npm run check --workspace=@repa/web
npm run test --workspace=@repa/web
npm run build --workspace=@repa/web
```

- 行为测试检查用户可观察的结果，例如选择、提交、错误反馈和焦点恢复，不以类名快照代替。
- 视觉或交互改动在浏览器核对窄屏和键盘操作，报告未完成的验证；构建通过不等于视觉验收。
- 设计决策、接入现状和组件来源分别更新设计系统规范、实现说明和通用组件说明；临时测试结果不写成设计规则。
