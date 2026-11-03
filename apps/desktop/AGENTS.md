# Desktop 的规矩

宿主、打包和安装包见[开发指南](../../docs/development/README.md)；renderer 就是 `apps/web`，界面的规矩见 [Web 前端开发规范](../web/AGENTS.md)。

- **安装包带的 Git 以 GPLv2 发布。** 分发安装包时，在同一个 Release 附上所带 dugite-native 版本的源码包。
- **学习者版本固定装配学习插件、关掉通用 Agent（[learner.ts](src/main/learner.ts)）。** 这是测试版的产品组合，不是底座的限制；以后由用户启用或停用插件，见 [#41](https://github.com/Utopia-V/repa/issues/41)。
- **安装包没有代码签名。** dmg 只做 ad-hoc 签名，Windows 安装程序未签名，这是测试阶段的做法。
