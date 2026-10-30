<!-- 由 scripts/docs/gen-packages.ts 生成，不要手改。 -->

# 包地图

| 包名 | 目录 | 概述 |
| --- | --- | --- |
| @repa/base | [base](./base/README.md) | @repa/base 把空间文件、长期状态插件和 Agent 会话接到一个本机协议上。 |
| @repa/learning | [learning](./learning/README.md) | @repa/learning 提供课程格式、读取和检查、任务与提交的公开契约（@repa/learning/protocol），以及只记事实的学习记录、恢复命令和学生模型接入。 |
| @repa/learning-model | [learning-model](./learning-model/README.md) | @repa/learning-model 提供 HSRS 学生状态更新与任务候选选择，是不读写文件、不读取时钟的 TypeScript 纯计算库。 |
| @repa/python-runner | [python-runner](./python-runner/README.md) | @repa/python-runner 在 Pyodide 里运行 Python 程序：页面在 Worker 里运行学习者的代码，Node 在 Linux 沙箱里运行课程核对的任务。 |
| @repa/space-history | [space-history](./space-history/README.md) | @repa/space-history 为普通空间目录保存文件历史，也能用于已有 Git 仓库的目录。 |
