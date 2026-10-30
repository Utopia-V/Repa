<!-- 由 scripts/docs/gen-packages.ts 生成，不要手改。 -->

# 包地图

| 包名 | 目录 | 概述 |
| --- | --- | --- |
| @repa/base | [base](./base/README.md) | @repa/base 把空间文件、长期状态插件和 Agent 会话接到一个本机协议上。 |
| @repa/learning | [learning](./learning/README.md) | @repa/learning 是 Repa 的学习插件：按课程安排上课、复习和测验，只记学习者的作答事实，学习状态从事实重算；包内还有课程格式、课程检查工具和随包的 Python 课。 |
| @repa/learning-model | [learning-model](./learning-model/README.md) | @repa/learning-model 提供 HSRS 学生状态更新与任务候选选择，是不读写文件、不读取时钟的 TypeScript 纯计算库。 |
| @repa/python-runner | [python-runner](./python-runner/README.md) | @repa/python-runner 在 Pyodide 里运行 Python 程序：页面在 Worker 里运行学习者的代码，Node 在 Linux 沙箱里运行课程核对的任务。 |
| @repa/space-history | [space-history](./space-history/README.md) | @repa/space-history 为普通空间目录保存文件历史，也能用于已有 Git 仓库的目录。 |
