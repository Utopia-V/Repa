# Repa

Repa 是一个个人学习助手，也是 LLM 与人的长期工作之间的 harness。LLM 无状态、上下文有限，而人的长期事业需要持续演化的状态。Repa 把状态存在模型之外，每次运行时投影进上下文，再由模型的行动和程序的计算来更新。

学习是第一个领域。学过的内容是学习者可见、可以直接书写的个人知识库；不同主题与课程分层隔离，程序按当前任务拼出模型需要的上下文；学习闭环参照 Math Academy，由真实作答更新学生模型，再据此建议练什么、复习什么。

## 现状

Repa 正在重做，目前只为维护者自用，只在 Linux 上运行，不提供安装包。目标与当前阶段的取舍见 [AGENTS.md](AGENTS.md)，设计记录见 [.agents/notes](.agents/notes/README.md)。

仓库里现有的是学生模型的纯计算库 [`@repa/learning-model`](packages/learning-model/README.md) 与 Web 前端的基础组件。此前面向试用者的完整实现（底座、学习插件、桌面端）保存在标签 `pre-slim`。

```sh
npm ci
npm test
```

## 研究

学习研究见[学习闭环与研究问题](docs/research/learning-loop.md)和 [MA 参考](docs/research/math-academy.md)。
