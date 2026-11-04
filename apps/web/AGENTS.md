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
- 通用 hover、active、focus、disabled 等视觉行为修改基础组件，不通过逐页 CSS、子元素选择器或 className 覆盖。
- `src/components/domain` 组合基础组件和业务状态，将 selected、completed、current、error 等映射到已有语义，不重新定义基础视觉语言；不依赖页面 CSS 才能正确显示。
- 页面级样式主要负责 layout、响应式、组合和页面间距；颜色、边框色、圆角、阴影、字号与组件状态优先由组件持有。允许使用 Tailwind，使用位置由职责决定。

## 组件实现与交互

- 基础组件不持有学习业务数据；业务组件通过 props 表达业务状态；页面或 feature 负责数据接入和组合，不为每个页面复制基础组件。
- 复用现有 shadcn/Radix 的焦点管理、键盘操作和复合控件行为。更新上游源码前核对本地适配，不直接覆盖项目 variant、尺寸和可访问性规则。
- 圆角、字号、留白和新增 token 的限制，Button 几何，`className` 的调用边界，选择、焦点与标签的可访问性要求，都以[设计系统规范](../../docs/design-system.md)为准，不在此复述。
- 图标按钮提供可访问名称，交互组件支持键盘操作，错误说明关联到对应输入。
- 组件不得依赖调用页面的 CSS 才能正确显示，不维护第二套 token 展示值。
- 新增或修改界面需处理窄屏、内容换行、文字放大和减少动态效果偏好；不得通过缩小正文或禁用缩放隐藏布局问题。
- 界面上给人看的文字不用模型生成，也不由 Agent 改写；Agent 只列出文字、标出可删的及理由，按人写好的原话实现。能由结构、默认值或按钮名称表达的，不另写说明句。见 [#101](https://github.com/Utopia-V/Repa/issues/101)。

## 数据与接入边界

- 界面是学习状态的视图：呈现后端算出的进度与状态，不另加与学习无关的指标。作答前不显示知识点、进度只在新课显示等规则见[学习契约](../../docs/development/learning-protocol.md#状态与方法)。
- 学习页面目前为学习插件写定。界面能否由插件或 Agent 生成的组件组成，由 Aqua 调查；现有页面的结构不约束以后。
- 后端能力通过现有 `@repa/base/client` 与 `@repa/base/protocol` 接入；组件层不自行实现协议、持久化或模型调用。
- 沿用已有路由、启动状态和连接交付入口，不增加并行的连接或配置机制。
- 新依赖先核对锁定版本和已有能力；不因参考其他产品而引入第二套基础 UI 库或主题运行时。
- 迁移既有页面时检查主题和基础样式的加载范围，避免全局 reset 意外影响其他入口。同步更新开发文档中的实际接入范围。

## 开发与验证

- 开发：运行 `npm run dev:web`，通过主应用验证界面；看学习界面用 `npm run dev:web:learning`，它按学习者版本启动后端。
- 实现变更运行以下 Web 检查；仅文档修改检查链接和规则一致性，无需重复构建。

```sh
npm run check --workspace=@repa/web
npm run test --workspace=@repa/web
npm run build --workspace=@repa/web
```

- 行为测试覆盖用户可观察的结果，例如选择、表单提交、错误反馈和焦点恢复；不以类名快照代替交互验证。
- 视觉或交互改动在浏览器核对受影响场景，包括窄屏和键盘操作；报告未完成的验证，不将构建通过等同于视觉验收。
- 稳定设计决策更新 `docs/design-system.md`；文件责任、接入方式和迁移现状更新设计系统实现说明；依赖来源与组件适配更新通用组件说明。不将临时测试结果写成长期设计规则。
