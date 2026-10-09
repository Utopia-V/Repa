# 官方学习产品与教学辅助

`@repa/learning` 在 Repa 通用底座上装配学习语境、教学方法、材料、规划、独立复习和整理能力。学习语境的组成规则、持久格式与背景快照由本包持有；`learn-with-feedback` 使用已有教材、讲义与尝试提供局部讲解、提示或反馈。

当前提供教学辅助、内容接续，以及[作答与可更正判断](../../docs/development/learning-attempts.md)的共同领域入口。原始作答及依据固定保存，候选判断与明确采用分别记录；沿知识关系更新学生状态、据此选择学习任务的闭环程序入口仍待研究实现。已确认的领域含义见 [CONTEXT.md](CONTEXT.md)。

## 使用

在仓库根目录运行 `npm run dev:backend -- /path/to/space`，或安装后运行 `repa-learning /path/to/space`。程序化启动使用产品入口：

```ts
import { startLearningServer } from "@repa/learning/product";
import { RepaClient } from "repa/client";
import { callLearning } from "@repa/learning/client";

const server = await startLearningServer({ appDirectory: "/path/to/repa-app" });
const client = await RepaClient.connect(server.connection);
try {
  const space = await client.call("space.open", { path: "/path/to/space" });
  const context = await callLearning(client, "context.get", { spaceId: space.id });
  console.log(context.binding, context.revision);
} finally {
  await server.close("cancel");
  await client.close();
}
```

`learningApplicationOptions` 把产品组合追加到已有宿主选项，`createLearningApplication` 用同一份装配创建应用。自定义插件与包继续保留，自定义提示默认值可以明确设为空；已保存的用户覆盖由底座的配置入口解析。纯 Repa 的 `startRepaServer` 和 `RepaApplication` 不默认安装学习能力。

`@repa/learning/client` 与 `@repa/learning/protocol` 可用于客户端，分别提供经 `capability.invoke` 调用的类型化 helper 和领域方法的 schema。学习能力不是核心 RPC。作答与判断使用 `attempt.get/record/judgment.save/judgment.select`；语境继续调用 `callLearning(client, "context.get" | "context.set" | "context.preview", params)`，实际实现沿当前插件配置选择。服务端的 `LearningAttempts`、`LearningContext`、快照 codec 和 `learningPluginRegistration` 从包主入口导出；只需语境能力的宿主可以安装这一轻量注册，不装配整个产品。

文本作答页面可以通过宿主绑定的 `repa.attempt.record-display/1` 直接形成记录。初始化和提交格式由 `@repa/learning/schema` 的 `ExerciseInitialSchema`、`ExerciseSubmissionSchema` 提供；实际展示来源、固定条件与页面报告分开保存，详见[组件接入](../../docs/development/learning-attempts.md#文本作答组件的展示接入)。

支持 `repa.learning-response/2` 的组件可以通过 `attempt.display` 恢复原 HTML、原题条件与先前提交。宿主用返回的 `source` 建立新展示并重新绑定动作；读取不新建作答，继续提交则把旧回答和帮助保留为前置条件。版本 `1` 继续可读、可保存，但不承诺交互恢复，详见[恢复约定](../../docs/development/learning-attempts.md#恢复原题与先前回答)。

## 关闭与验证

`plugins.disabled` 中的 `repa-learning` 关闭整个官方组合，`repa-teaching` 只关闭教学 Skill。已有文档、语境绑定和复习记录继续保留；语境的安装级格式解释也继续用于内容保存和空间复制。教学方法见 [learn-with-feedback](skills/learn-with-feedback/SKILL.md)，产品启用、替换及历史验证见[官方学习组合](../../docs/development/official-learning.md)，语境格式与接口见[学习语境](../../docs/development/learning.md)。

在仓库根目录先运行 `npm run build:backend`，再运行 `npm run check --workspace=@repa/learning` 和 `npm test --workspace=@repa/learning`。产品测试检查选项合成、明确空覆盖及通过真实能力入口保存和重传绑定；作答回归覆盖原始证据、判断与采用、更正冲突、实际 Pi 调用和副本独立保存；跨会话语境与快照恢复由主包的集成回归覆盖。
