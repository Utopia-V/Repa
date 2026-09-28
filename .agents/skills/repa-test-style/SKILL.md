---
name: repa-test-style
description: 编写、修改或审阅 Repa 测试时使用，规定后端与前端的测试入口、行为命名、夹具隔离、断言、异步等待和 SDK 集成写法。
---

# Repa 测试规范

本规范规定项目测试的具体写法。测试保护的行为来自相应接口与已接受设计；新增测试的必要性和验证范围随实际改动判断。

## 框架与目录

- 后端使用 Node 自带测试器、`node:assert/strict` 和 `tsx`。测试放在后端包的 `test/*.test.ts`；当前后端包位于仓库根目录。不要把测试移进未被脚本发现的子目录。
- 使用 `import test, { type TestContext } from "node:test"` 和 `import assert from "node:assert/strict"`。文件名按模块或行为使用小写连字符，沿用相邻测试粒度。
- 固定样本放在 `test/fixtures/`，例如扩展包、子进程入口和旧版本会话；注明必要的生产版本与用途。可在测试中生成的小文件使用临时目录。
- 已有 Web／Electron 前端使用各自 workspace 的 Vitest 与 Testing Library；测试放在所属 `test/`，沿用该 workspace 的配置与近端 `AGENTS.md`，不套用后端 Node 测试入口。

## 命名与断言

- `test` 名称用简体中文写出情境和可观察结果，例如“清理历史后重传旧操作，不再次执行保存”；避免只写函数名或“正常／异常”。
- 一个测试可以包含验证同一行为所需的连续操作。准备、操作和断言按发生顺序排列；只为独立情境拆分测试，不为每个断言另建用例。
- 相等值用 `assert.equal`，结构用 `assert.deepEqual`，异步失败用 `await assert.rejects`。除文案本身属于契约外，产品错误断言 `RepaFault.code`，公开调用断言 `RpcError.data.code` 及必要细节，不锁定整段错误文案。
- 文件编辑的保留范围用原始字符串或字节断言，包含相关的 Unicode 与换行；不要先 `trim()` 或规范化文本，再声称原文被保留。
- 生成的 ID 用返回结果关联；不硬编码随机 ID、临时路径或当前时间。并发保存检查成功与冲突的关系，不指定没有顺序契约的胜者。
- 前端用角色、可访问名称、文本与交互结果定位和断言；布局类名快照不能代替操作、焦点和状态验证。

## 夹具与依赖

- 夹具使用 `fixture(t: TestContext, options)` 等局部函数返回实际需要的对象；重复结构确实由多个文件共用时才提取共享夹具，不建立通用测试应用框架。
- 文件测试使用 `mkdtemp(path.join(os.tmpdir(), "repa-模块-"))`，将学习空间、应用配置、凭据文件与会话目录放在其中。通过 `t.after` 关闭创建的客户端、后端和子进程，再清理目录；也覆盖中途失败的清理。
- Pi 接入测试使用锁定的真实 SDK 和本地 `fauxProvider`。显式使用临时 `authPath`，关闭模型网络发现与初始化刷新，不读取个人模型配置、不依赖付费调用。
- 断言模型行为时观察 provider 实际接收的 `TranscriptContext`，用 Pi 的公开函数读取系统提示和工具声明；不要只验证 Repa 中间装配函数。
- 内容、持久化与恢复测试使用真实临时文件；应用协议测试使用实际 `RepaClient` 和本地 HTTP／WebSocket 后端。替身放在模型服务或确需隔离的外部边界，不替换掉本次要验证的保存、订阅或 SDK 行为。

## 异步与时间

- 等待事件、请求完成或明确状态。有必要轮询时使用带截止时间的 `until` 等局部助手；超时输出相关状态。
- 固定延时可以构造竞争时序，不能作为任务已经完成的证据。后台工作和清理都要有可等待的结束条件。
- 租约等逻辑时间使用模块已有的可注入时钟；不全局修改系统时间。取消测试分别检查发出取消与实际终态，重启测试关闭原实例后从持久数据建立新实例。

## 运行入口

以下命令在当前后端包根目录运行；workspace 调整后以所属 `package.json` 为准。

```sh
npm test
node --import tsx --test test/pi-context-integration.test.ts
node --import tsx --test --test-name-pattern='旧历史' test/pi-context-integration.test.ts
npm run check
```

检查新增测试被普通测试入口发现。修改静态文档或格式不为了凑验证而新增测试；涉及 UI 的视觉结果另按前端规则在真实界面核对。
