# 后端诊断日志

排查一次任务时，你可以从请求编号开始，查找它进入了哪个运行、调用过什么工具，以及怎样结束。后端把这些经过写成逐行 JSON，通过 stderr 输出；其中的时间点也可以用来计算首次状态反馈和首段回答的等待时间。Web、Desktop 和自动启动的 CLI 后端会把输出保存在原有的 `<连接文件>.log` 中。

## 设计思路

请求记录会保存任务的最终状态，但排查一次失败时，我们往往还需要知道它是怎样走到这个结果的。例如，输入有没有进入运行，工具是否已经执行，当时又是否在等待用户回答。诊断日志把这些步骤按发生时间记下来，供我们沿着同一次请求查看经过。

要把经过连起来，日志需要使用请求和运行原有的编号。受理输入时记录 `requestId`，输入实际进入运行以后，再用 `runId` 找到相应的工具、交互和结束事件。这样，从一个请求编号出发就能逐步找到相关记录；如果还需要完整的业务结果，也可以用这个编号回到请求查询接口。

这些编号和状态都由执行相应行为的模块提供。应用在受理请求、发布运行状态和处理交互时写入事件，协议服务记录连接与调用，工具的开始和结束则直接使用 Pi 已有的事件。记录从实际发生的位置取得，也就能保留它们原来的归属，而不需要另外接管一遍工具执行。

有了这些关联，日志可以把重点放在事件、状态、长度和时间上，详细业务结果仍通过原有记录查询。记录器因此只接收明确列出的元数据字段，不写入输入正文、工具结果或凭据。即使开启 debug，增加的也是调用与运行阶段的信息，而不是原始请求载荷。

事件取得以后，还需要一个能持续写入的出口。现有宿主已经把后端 stderr 接到文件，因此日志可以直接使用这条通道。不过，后台任务可能在界面关闭后继续执行，这段时间的日志也需要保存。后端为此使用继承的文件描述符独立写入并控制大小，不依赖界面进程继续接收输出。

持续写入又会让文件不断增长，所以当前按 10 MiB 控制受管日志：如果下一条 Repa 诊断会使文件超过上限，就先清空文件，再写入完整的一行。这种方式只维护当前片段，代价是旧片段会被丢弃。第三方直接输出的处理和长期收集方式见[文件大小与失败处理](#文件大小与失败处理)。

## 实现细节

### 开关与输出位置

默认级别为 `info`。启动后端前设置 `REPA_LOG_LEVEL`，可选择 `debug`、`info`、`warn`、`error` 或 `off`。例如，在仓库根目录启动独立后端：

```sh
REPA_LOG_LEVEL=debug npm run dev:backend -- serve --connection-file /tmp/repa-connection.json
```

运行这条命令后，你会在终端的 stderr 中看到诊断输出。如果由 Web 开发宿主、Desktop 或 CLI 自动启动后端，输出就会进入各自连接文件旁的 `.log`，具体启动方式见[开发指南](README.md)。级别在后端启动时确定，因此，要改变已有后端的日志级别，需要重新启动它，而不是仅重新连接客户端。

如果你在其他程序中调用 `startRepaServer` 或 `RepaApplication`，可以通过 `diagnostics.level` 覆盖环境变量，也可以提供 `diagnostics.write(line)`，把完整 JSON 行交给自己的收集程序。默认实现会异步、按顺序写入 stderr；自定义实现则可以同步或异步完成。两种方式的输出失败都由诊断模块处理，不改变业务调用的结果。

### 记录字段与事件

[diagnostics.ts](../../packages/repa/src/diagnostics.ts) 定义允许输出的字段。每条记录都有 Unix 毫秒时间 `time`、`level`、`event` 和用于区分后端实例的 `applicationId`；其他字段按事件填写。

| 事件 | 可以查询的经过 |
| --- | --- |
| `connection.opened/authorized/closed/failed` | 连接建立、授权、断开和传输失败，用 `peerId` 关联，不记录连接令牌 |
| `request.accepted` | 请求受理，包含 `requestId`、空间／会话编号、`submittedAt`、输入文字长度和部分数量 |
| `request.state` | 请求状态或实际 `runId` 改变；运行中补充、排队取消和未投递输入也能按各自编号定位 |
| `run.started/first_status/first_text/finished` | 运行开始、首次状态发布、首段非空回答文字与结束，均包含 `runId` 和主请求编号 |
| `tool.started/finished` | Pi 工具调用开始与结束，包含工具名、`callId` 和所属运行，不记录工具参数或结果正文 |
| `interaction.opened/replied/closed` | 交互发起、答复或取消／超时结束，包含交互编号和所属请求，不记录问题与回答正文 |
| `processing.accepted/running/cancelling/completed/cancelled/failed/interrupted` | 独立后台请求的实际状态变化，不把重启时读取的旧终态记成本次完成 |
| `runtime.failed/input.failed/runtime.notice` | 运行异常、补充投递失败和运行通知，保留错误代码及适用的异常类型 |
| `rpc.failed/http.failed` | 协议调用或资源访问失败，记录已知方法、范围和错误代码，不复制载荷、路径和异常正文 |
| `application.state`、`server.started/closed` | 应用与协议服务的生命周期 |

上表记录的是任务与运行的主要经过。如果还要查看普通查询耗时或更细的运行阶段，可以开启 debug，取得 `rpc.started/completed` 和 `run.state`。

协议调用另有一个 `rpcId`，用于关联同一次 JSON-RPC 调用的开始、完成或失败。它与应用受理任务时使用的 `requestId` 不同，所以排查学习任务时应先找 `requestId`；需要进一步追查某次协议调用时，再使用 `rpcId`。

例如，你在运行中补充一条输入后，可以先检索这条输入的 `requestId`。如果输入已成功绑定到运行，`request.state` 就会给出实际的 `runId`；接着用这个编号，就能找到相关工具、交互和运行结束事件。如果目标运行已经结束，输入会记为 `not_entered`，表示这次补充没有进入运行。

```sh
jq -R 'fromjson? | select(.requestId == "要查询的请求编号")' /path/to/connection.json.log
```

这里使用 `fromjson?`，因为启动提示、Pi 或受信任扩展可能直接向 stderr 输出普通文字。Repa 自己的诊断记录逐行使用 JSON，不改写第三方输出。

### 等待时间的含义

计算等待时间时，我们从后端受理请求开始计时。`submittedAt` 就是受理记录的 `createdAt`；如果请求先排队，过一段时间才开始运行，这段排队时间也会包含在内。至于点击到请求受理之前的时间，以及收到结果后的浏览器渲染耗时，则需要由前端测量。

请求开始运行以后，应用首次发布状态时会记录 `run.first_status`，此时 `status` 通常为 `accepted`，`phase` 为 `preparing`。等会话适配层送来首段非空回答文字，再记录 `run.first_text`；思考内容不算作回答文字。

等结果保存并发布终态以后，后端才记录 `run.finished`，并把已经取得的 `firstStatusAt` 和 `firstTextAt` 放进这条结束记录。这样，计算等待时间时就不必分别寻找前面的事件，只需读取已有的时间字段：

```text
首次状态反馈等待 = firstStatusAt - submittedAt
首段回答文字等待 = firstTextAt - submittedAt
```

如果运行在生成文字之前就失败，结束记录中会缺少 `firstTextAt`，这时只能计算已经取得的时间点。除了这些时间点，结束记录还提供运行状态、错误代码和 `durationMs`。如果仅凭这些信息还不足以定位问题，就可以再调用 `request.get`，进一步查看 `modelAttempts`、用量和完整的业务错误。因为这些数据已经保存在请求记录中，所以诊断日志只需通过编号与它们关联。

### 文件大小与失败处理

[diagnostic-stderr.ts](../../packages/repa/src/diagnostic-stderr.ts) 使用现有 `SerialQueue` 按行写入，队列与业务保存队列分开。Web、Desktop 和 CLI 自动启动后端时，会以追加模式打开日志文件，把描述符交给后端，并设置 `REPA_MANAGED_STDERR=1`。后端据此识别可以自行控制大小的文件；普通前台运行和用户自行重定向的文件没有这个标记，因此不会被这套机制清空。

后端确认这是带标记的普通文件以后，会在每条诊断写入前读取它的实际大小。如果再写入这一行就会超过 10 MiB，就先把文件截为零字节，再写入完整的一行。截断仍通过原来的文件描述符进行，因此，即使宿主已经关闭自己的句柄，后端也能继续使用它。

这里检查的是文件大小，所以此前 Pi 等组件直接写入的内容也会计入。不过，检查只在 Repa 写入诊断时发生：如果第三方在两条诊断之间输出了大量内容，文件仍可能暂时超过上限，直到下一条 Repa 诊断写入前再作处理。

由于旧片段会被清空，如果你需要长期保留日志，可以前台运行后端，再使用外部工具收集 stderr。这类自行管理的文件应当保留默认设置，不添加 `REPA_MANAGED_STDERR` 标记。

默认实现通过 Node 文件描述符接口写入。如果某次写入失败，就结束这次诊断输出，不再向同一个 stderr 报错。日志被关闭、自定义出口同步抛错或异步拒绝时，也按同样原则处理，任务和保存操作照常完成。

## 未完成项与待验证项

后端诊断与现有宿主通道已经接通。前端在错误位置展示请求编号由 [#10](https://github.com/Utopia-V/repa/issues/10) 接续；安装后的日志位置提示、收集方式与实际分发验证由 [#26](https://github.com/Utopia-V/repa/issues/26) 接续。本轮验证了源码后端、真实宿主集成测试、临时日志文件和解包后的生产后端，没有重新安装到系统。

## 验证入口

在仓库根目录运行：

```sh
node --import tsx --import ./packages/repa/test/environment.ts --test packages/repa/test/diagnostics.test.ts packages/repa/test/diagnostic-stderr.test.ts packages/repa/test/model-api.test.ts
npm run check
npm test
npm run build
```

- [diagnostics.test.ts](../../packages/repa/test/diagnostics.test.ts) 使用真实协议和 Pi SDK，检查请求、运行、工具、交互、补充输入、后台任务与异常的关联，以及关闭输出和输出失败后的正常业务结果。
- [model-api.test.ts](../../packages/repa/test/model-api.test.ts) 通过实际认证接口配置测试密钥，并用真实 Pi SDK 调用本地 HTTP 模型服务。在 info 与 debug 两种级别下，密钥、连接令牌和输入正文均不进入诊断。
- [diagnostic-stderr.test.ts](../../packages/repa/test/diagnostic-stderr.test.ts) 使用真实子进程与临时文件，检查原 fd 的追加与截断、宿主句柄关闭、用户文件保留以及输出故障。

上述测试包含运行中补充输入的实际归属检查，独立审阅已完成。加入本批空间进入、内容关系和 Web 集成测试后，全仓类型检查、测试与构建全部通过，共 455 项测试通过、1 项按可选组件环境条件跳过。

Linux 安装包解包检查实际收集了包内后端的 stderr，确认启动和后台处理结束事件可定位，连接令牌不在日志中；该检查由[安装布局验证脚本](../../apps/desktop/scripts/verify-linux-package.mjs)执行。源码测试使用 Node 24.19.0，包内使用 Electron 所带的 Node 24.20.0。
