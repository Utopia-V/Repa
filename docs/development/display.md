# 交互产物展示与受限桥接

你可以通过展示接口打开一份 HTML 产物，调整其中的参数，把结果保存成新文档、交给指定会话中的 Agent，或交由宿主绑定的能力处理。后端负责这次展示的身份、内容版本、资源和动作；实际页面加载、隔离与界面状态由前端宿主负责。

## 设计思路

同一份实验可能在两个窗口中打开。你在其中一个窗口修改源文件时，另一个窗口还可能使用旧页面计算结果。因此，打开展示时需要固定实际使用的版本；保存结果时，也要把这个版本和当时的参数一起留下。以后重开时仍使用原来的页面版本，组件再按其约定从保存参数恢复状态，而不是把新页面和旧参数拼在一起。

展示页面还需要使用应用能力，例如保存结果或请求解释。若把完整客户端交给页面，它就能访问与本次实验无关的空间、配置和操作。当前由可信宿主先选定保存位置或目标会话，再为实例绑定具名动作。页面只提交动作参数，后端从实际连接和实例记录中建立来源与调用范围。

这里复用 MCP Apps 的 `AppBridge` 和 `PostMessageTransport` 处理消息与初始化，不增加一套页面 RPC 协议。内容版本和临时持有使用原资源模块，保存和向 Agent 投递也分别进入原内容与请求入口。展示模块只保留实例及其临时授权，关闭页面后，已受理的工作由对应请求完成。

## 实现细节

### 打开实例与固定版本

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

### 绑定保存和提交动作

当前提供三种动作，目标由宿主在 `display.open` 时确定：

| 动作 | 宿主绑定 | 页面提交 |
| --- | --- | --- |
| `save-new-result-document` | 空间内的新文档路径、参数 `inputSchema` | 本次 `requestId` 和实验参数或结果 |
| `submit-result-to-agent` | 当前空间中的 `sessionId`、任务 `instruction`、参数 `inputSchema` | 本次 `requestId` 和实验参数或结果 |
| `process-display-result` | `processResult.selection` 与参数 `inputSchema`；打开时固定具体能力实现 | 本次 `requestId` 和页面提交值 |

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

这些动作都在受理时建立请求自己的资源保留关系。关闭实例会取消尚未受理的投递；已经受理的工作可以完成，最终状态由宿主通过 `request.get` 或订阅呈现。相同 `requestId` 和相同输入重传时取得原记录，改变输入则返回 `request_id_conflict`。

### 交给绑定能力处理

例如，学习页面可以把一次回答直接交给学习能力记录，而不先保存一份通用结果文档、再等待宿主完成第二次录入。宿主在 `display.open` 中提供：

```ts
processResult: {
  selection: { contract: { id: "repa.attempt.record-display", version: "1" } },
  inputSchema: { ...ExerciseSubmissionSchema },
}
```

这里的示例需要安装官方学习能力，`ExerciseSubmissionSchema` 从 `@repa/learning/schema` 导入。初始化与提交格式见[学习作答组件](learning-attempts.md#文本作答组件的展示接入)。其他领域可以提供自己的处理能力；通用展示模块不解释回答或评分。

打开时按宿主选择与当前配置解析具体 `contract/version/implementationId`。页面只看到动作名和提交 schema，不能改选能力或传入完整调用上下文。后续默认实现变化不改变这个绑定；受理时仍检查原实现是否可用，关闭或移除后明确失败，不回退到其他实现。

服务器根据实例构造 `DisplayResult`，再以 `ProcessDisplayResultInputSchema` 所定义的 `{ operationId, result }` 调用能力。`operationId` 稳定使用本次 `requestId`；`result` 中的来源、HTML 和初始化条件都来自服务器实例，只有 `input` 来自页面。能力取得真实的 `source.kind = "display"`，模型服务、权限检查和资源操作继续由原能力宿主装配。处理动作沿持久请求接续，所以只接受 `inline` 或 `background` 定义，不能绑定不建立请求的 `query`。

处理能力可以通过原 `inputResources` 声明所需资源，声明必须落在本实例的 hold 范围内。请求保存实际的能力输入 `{ operationId, result }`，外层资源清单同时包含原展示资源与已验证的声明资源；内部结果的 artifact、initialData 和页面 input 保持原值。这样，即使重开的结果文档另有不在原 HTML 清单中的附件，关闭展示之后，已受理的处理也不会丢掉这些输入。能力输出和失败表示的资源继续沿既有请求规则持有。

处理请求的 operation 为 `repa.display.process-result`，配置保留绑定实现、真实来源和业务操作标识。受理前关闭实例会拒绝提交，受理后则使用处理请求自身的取消信号。相同请求重传先返回已有记录，不要求旧实例仍打开，也不会重新选择实现。进程重启将未完成请求保留为 `interrupted`，不自动续跑；请求取消或中断也不能据此推定内容没有提交，可信宿主可用保存的 `operationId` 查询 `operation.get` 核对。

### 浏览器接入 MCP Apps

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

### 关闭、历史重开与空间副本

关闭展示时，宿主分别关闭 SDK 桥接和后端实例。短暂断线沿用客户端宿主键和已有重连宽限期；确认离开或宽限期结束后，后端撤销实例动作。确认关闭会释放宿主 hold，异常失联留下的资源按原 TTL 处理。

保存和向 Agent 投递的结果都使用 `repa.display-result/1`，包含当时的展示来源、HTML 表示和提交参数 `input`。如果本次实例有初始化参数，还会以 `initialData` 原样保存。例如，同一份练习页面用初始化参数选择题目，提交参数只包含回答时，结果仍能保留当时用于初始化的题目条件。明确的 `null`、空字符串或其他空值也保留；没有初始化参数的旧记录保持原样。

这两份数据各有用途：`initialData` 记录本次初始化条件，`input` 记录页面提交的结果。重开沿用原约定，以已保存的 `input` 初始化新实例，保存和提交动作由当前宿主重新绑定。文档登记自己的资源关系，所以清理原会话或释放展示实例后，它仍能重开。

结果固定的是 HTML、初始化参数和页面提交值，不自动记录动态 DOM 或逐次提示的显示过程。页面需要在提交值中明确携带要保留的操作事实；这些仍是页面上报的数据，实际呈现与操作的验证由宿主承担。参数中的资源引用也需要在产物 `resources` 中明确声明，不因出现在 JSON 内就自动取得持有关系。

复制空间时，结果 JSON 的原字节保持不变。展示格式负责把其中供本次使用的内容、资源引用映射到副本；产生这份结果的原宿主和实例仍保留为历史来源。这样可以在副本中使用原结果，也能查明它最初从哪里产生。

格式 owner 可以复用 `repa/plugin` 或 `repa/display` 导出的 `displayResultArtifact(result, spaceId)`。这个纯函数只复制 artifact 并映射原空间的标准引用，不验证资源持有，不改变历史来源或任意页面参数。领域需要不同恢复语义时，由领域入口解释固定参数，再通过 `source.kind: "artifact"` 打开。例如，[学习作答恢复](learning-attempts.md#恢复原题与先前回答)把原题条件与先前提交分开交付，不改变上述通用重开规则。

## 未完成项与待验证项

| 项目 | 当前状态与影响 | 接续位置 |
| --- | --- | --- |
| 官方展示宿主 | 后端与浏览器桥接可用；组件选择、页面装载、隔离、导航、动作状态和不可用提示尚未接入官方界面 | [#10](https://github.com/Utopia-V/repa/issues/10) 与 [#23](https://github.com/Utopia-V/repa/issues/23) |
| 完整展示隔离验收 | 已用独立浏览器联调宿主验证消息、调参、保存和旧版本重开；生产宿主的隔离与网络策略需要在其实际实现上验证 | #23 前后端联合验收 |
| 其他格式与动作 | 当前提供 HTML、新结果文档、会话提交及绑定能力处理；更多渲染器和有修改基准的覆盖动作尚未接入 | 由实际消费能力声明契约与授权范围 |

## 验证入口

[display-api.test.ts](../../packages/repa/test/display-api.test.ts) 使用真实后端、MCP Apps SDK 与 Pi，覆盖不同实例版本、有限资源和动作、受理后关闭与回收、多资源结果、历史重开、空间副本和向绑定会话投递。

[display-processing.test.ts](../../packages/repa/test/display-processing.test.ts) 覆盖绑定处理器的实际 SDK 调用、来源与输入边界、固定实现、关闭前后受理、声明资源的接续、重传，以及内容已提交后请求取消时的操作核对。

初始化参数回归核对 SDK 实际收到的值与保存／投递结果一致，区分缺省和明确空值，并覆盖重传、重开与空间复制。重开仍消费提交数据，旧结果不补造原初始化条件。

浏览器联调中，实验参数从 1 调到 3 后保存；修改源 HTML，再关闭并重开结果，页面保留原 HTML 版本和参数。重开实例没有绑定保存动作，页面对应按钮不可用。该联调页使用单独的测试宿主，官方宿主仍按上表接续。
