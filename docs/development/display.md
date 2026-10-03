# 交互产物展示与受限桥接

你可以通过展示接口打开一份 HTML 产物，调整其中的参数，把结果保存成新文档，或交给指定会话中的 Agent。后端负责这次展示的身份、内容版本、资源和动作；实际页面加载、隔离与界面状态由前端宿主负责。

## 设计思路

同一份实验可能在两个窗口中打开。你在其中一个窗口修改源文件时，另一个窗口还可能使用旧页面计算结果。因此，打开展示时需要固定实际使用的版本；保存结果时，也要把这个版本和当时的参数一起留下。以后重开这份结果，就能回到原来的实验，而不是把新页面和旧参数拼在一起。

展示页面还需要使用应用能力，例如保存结果或请求解释。若把完整客户端交给页面，它就能访问与本次实验无关的空间、配置和操作。当前由可信宿主先选定保存位置或目标会话，再为实例绑定具名动作。页面只提交动作参数，后端从实际连接和实例记录中建立来源与调用范围。

这里复用 MCP Apps 的 `AppBridge` 和 `PostMessageTransport` 处理消息与初始化，不增加一套页面 RPC 协议。内容版本和临时持有使用原资源模块，保存和向 Agent 投递也分别进入原内容与请求入口。展示模块只保留实例及其临时授权，关闭页面后，已受理的工作由对应请求完成。

## 打开实例与固定版本

方法和格式由 [display/schema.ts](../../packages/repa/src/display/schema.ts) 定义，经 `repa/protocol` 导出。

| 方法 | 用途 |
| --- | --- |
| `display.open` | 用调用方生成的 `instanceId` 打开内容或已保存的 HTML 表示，固定版本、持有资源并绑定本次动作 |
| `display.get` | 取得当前实例与资源 hold，并续期这份持有 |
| `display.readResource` | 读取该实例已持有的资源，返回资源说明和 base64 字节 |
| `display.invoke` | 使用 `requestId` 发起已绑定的动作，返回会话请求或后台请求记录 |
| `display.close` | 关闭实例并释放其临时持有，重复关闭可直接结束 |

实例归认证连接的真实宿主所有。`source.kind: "content"` 使用 `ContentTarget`；普通 HTML 取得当前实际字节，保存的结果 JSON 则由展示模块解释。`source.kind: "artifact"` 接受 `repa.display-html/1` 表示和可选的 `initialData`，适合从已有历史表示重开。

`repa.display-html/1` 的 `value.resource` 指向 HTML 原件，`sources` 记录内容来源和修订，`resources` 声明所需附属资源。后端通过一次 `resource.hold` 保留它们。两个实例各自持有自己的版本；源文件后来发生变化时，已打开实例仍可读取原字节。

当前入口支持 HTML。宿主收到 `unsupported_format` 时，应提供已有的静态表示或源码入口；其他格式的处理器由所属展示能力接入。

## 绑定保存和提交动作

当前提供两种动作，目标由宿主在 `display.open` 时确定：

| 动作 | 宿主绑定 | 页面提交 |
| --- | --- | --- |
| `save-new-result-document` | 空间内的新文档路径、参数 `inputSchema` | 本次 `requestId` 和实验参数或结果 |
| `submit-result-to-agent` | 当前空间中的 `sessionId`、任务 `instruction`、参数 `inputSchema` | 本次 `requestId` 和实验参数或结果 |

下面的宿主示例假定 `client` 已连接，`spaceId` 和 `sessionId` 来自已打开的空间与会话：

```typescript
const inputSchema = {
  type: "object",
  properties: {
    amplitude: { type: "number", minimum: 0, maximum: 5 },
    result: { type: "number" },
  },
  required: ["amplitude", "result"],
  additionalProperties: false,
};

const instance = await client.call("display.open", {
  spaceId,
  instanceId: crypto.randomUUID(),
  source: {
    kind: "content",
    target: {
      kind: "file", spaceId,
      location: { kind: "relative", path: "experiments/wave.html" },
    },
  },
  saveNewResult: { path: "results/wave-01.json", inputSchema },
  submitResult: {
    sessionId, instruction: "请结合这次实验参数解释观察结果。", inputSchema,
  },
});
```

你选择保存时，后端先受理 `repa.display.save-result` 请求，再通过一次 `content.applyPatch` 新建文档并登记资源。目标必须尚不存在，期间被其他操作占用时返回保存冲突。再次保存为另一份结果，需要由宿主选择新路径并建立相应绑定。

你选择提交给 Agent 时，后端把宿主绑定的任务指令和本次结果组成结构化输入，进入指定会话的队列。页面中的参数保留为展示数据，记录的 `source.kind` 为 `display`，包含真实的宿主、空间和实例标识。已有队列暂停时，这项输入也按原队列规则等待。

两种动作都先建立请求自己的资源保留关系。关闭实例会取消尚未受理的投递；已经受理的工作可以完成，最终状态由宿主通过 `request.get` 或订阅呈现。相同 `requestId` 和相同输入重传时取得原记录，改变输入则返回 `request_id_conflict`。

## 浏览器接入 MCP Apps

浏览器宿主从 `repa/display` 引入薄适配层，当前依赖 `@modelcontextprotocol/ext-apps` 2.0.3。下面的 `pageWindow` 由前端的隔离宿主提供：

```typescript
import { createDisplayBridge, PostMessageTransport } from "repa/display";

const bridge = createDisplayBridge(client, instance);
await bridge.connect(new PostMessageTransport(pageWindow, pageWindow));
```

先建立宿主端的监听，再让页面通过 SDK 的 `App.connect` 完成初始化。桥接随后用 `sendToolInput` 发送 `initialData` 和本次 `actions`；页面用 `ontoolinput` 接收它们。页面调用动作时使用 SDK 的 `callServerTool`：

```typescript
const receipt = await app.callServerTool({
  name: "save-new-result-document",
  arguments: {
    requestId: crypto.randomUUID(),
    input: { amplitude: 3, result: 1.5 },
  },
});
console.log(receipt.structuredContent); // requestId 与当前 status
```

`accepted` 表示已受理，宿主还需要展示之后的完成或失败状态。桥接只返回这份确认，不把完整请求中的提示或模型配置交给页面。

资源通过 SDK 的 `listServerResources` 和 `readServerResource` 取得，地址使用 `repa://display/<instanceId>/resources/<resourceId>`。附属数据和脚本的实际装载方式由渲染器处理；资源地址限定在当前实例的持有范围内。

`createDisplayBridge` 使用 `AppBridge(null, …)`，手动登记工具调用及资源列表、读取处理器。主连接令牌和 `hostKey` 留在宿主；页面发送的普通聊天消息、外链或模型上下文更新没有对应转发入口。生产宿主还需落实 iframe 隔离、CSP、导航和对外连接规则，这部分按 [ADR 0005](../adr/0005-execute-display-content-with-host-permissions.md#展示内容与交互) 与 [#10](https://github.com/Utopia-V/repa/issues/10) 接入。

## 关闭、历史重开与空间副本

关闭展示时，宿主分别关闭 SDK 桥接和后端实例。短暂断线沿用客户端宿主键和已有重连宽限期；确认离开或宽限期结束后，后端撤销实例动作。确认关闭会释放宿主 hold，异常失联留下的资源按原 TTL 处理。

保存的结果使用 `repa.display-result/1`，包含当时的展示来源、HTML 表示和提交参数。文档登记自己的资源关系，所以清理原会话或释放展示实例后，它仍能重开。重开会建立新实例，保存和提交动作由当前宿主重新绑定。

复制空间时，结果 JSON 的原字节保持不变。展示格式负责把其中供本次使用的内容、资源引用映射到副本；产生这份结果的原宿主和实例仍保留为历史来源。这样可以在副本中使用原结果，也能查明它最初从哪里产生。

## 未完成项与待验证项

| 项目 | 当前状态与影响 | 接续位置 |
| --- | --- | --- |
| 官方展示宿主 | 后端与浏览器桥接可用；组件选择、页面装载、隔离、导航、动作状态和不可用提示尚未接入官方界面 | [#10](https://github.com/Utopia-V/repa/issues/10) 与 [#23](https://github.com/Utopia-V/repa/issues/23) |
| 完整展示隔离验收 | 已用独立浏览器联调宿主验证消息、调参、保存和旧版本重开；生产宿主的隔离与网络策略需要在其实际实现上验证 | #23 前后端联合验收 |
| 其他格式与动作 | 当前提供 HTML、新结果文档和向指定会话提交；更多渲染器、练习提交或有修改基准的覆盖动作尚未接入 | 由实际消费能力声明契约与授权范围 |

## 验证入口

[display-api.test.ts](../../packages/repa/test/display-api.test.ts) 使用真实后端、MCP Apps SDK 与 Pi，覆盖不同实例版本、有限资源和动作、受理后关闭与回收、多资源结果、历史重开、空间副本和向绑定会话投递。

浏览器联调中，实验参数从 1 调到 3 后保存；修改源 HTML，再关闭并重开结果，页面保留原 HTML 版本和参数。重开实例没有绑定保存动作，页面对应按钮不可用。该联调页使用单独的测试宿主，官方宿主仍按上表接续。
