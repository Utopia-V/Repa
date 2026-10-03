# 长期内容整理

`@repa/organization` 提供 `organize-learning` Pi Skill。Agent 先读取已有材料、笔记和人工修改，再根据需要补充、拆分、合并或重组内容，并维护当前学习语境。

整理方法负责判断内容与引用的含义，确定的修改交给共同内容工具保存。包没有独立后台服务或数据库。官方默认以 `repa-organization` 加载，关闭后移除方法，已经保存的文档和学习语境保留。单独安装的版本使用 Pi 资源选择和 Repa 信任配置。

共同保存的取舍、工具输入和验证范围见[整理开发说明](../../docs/development/organization.md)。

在仓库根目录运行：

```sh
npm run build:backend
npm run check --workspace=@repa/organization
npm test --workspace=@repa/organization
```
