# Repa 底座骨架

`@repa/base` 把空间文件、长期状态插件和 Agent 会话接到一个本机协议上。Web 与 Desktop 已通过它连接本机服务；学习插件与领域界面接入留给后续任务。旧后端和领域包从 `pre-rebuild` 标签取用。

## 使用

在仓库根目录运行，要求 Node.js 22.22.2 以上与系统 Git：

```sh
npm ci
npm run build --workspace=@repa/space-history
npm run build --workspace=@repa/base
npm run start --workspace=@repa/base -- serve --home /path/to/repa-home
```

服务只监听 `127.0.0.1`，stdout 输出一行 `{ "url": "ws://…/rpc", "token": "…" }`。启动方应把这行内容当作私密连接信息交给客户端，不放进公开日志。省略 `--home` 时使用 `REPA_HOME`，再回退到 `~/.repa`；`REPA_TOKEN` 可提供已有令牌，否则随机生成。`--port` 默认自动分配，SIGINT、SIGTERM 会等待资源关闭。

加载示例插件：

```sh
npm run start --workspace=@repa/base -- serve \
  --home /path/to/repa-home \
  --plugin "$PWD/packages/base/dist/examples"
```

`--plugin` 可重复，每次传入一个构建目录，不接受源码文件路径。插件随产品构建和安装依赖；宿主先读取目录中的 `repa-plugin.json`，通过静态检查后才导入入口模块。入口导出 `default` 或 `plugin`，其中 `id` 必须与清单一致。这些产物仍是本机可信代码，清单检查不提供隔离。

装配可以关掉通用 Agent，并指定用户能直接对话的 Agent：

```sh
npm run start --workspace=@repa/base -- serve \
  --home /path/to/repa-home \
  --plugin "$PWD/packages/base/dist/examples" \
  --no-general-agent --direct-agent notes-organizer
```

`--direct-agent` 可重复；给出后只有这些 Agent 能直接对话，覆盖定义中的 `direct`，其中有不存在或已关掉的 Agent 时打开空间返回 `unknown_agent`。嵌入时对应 `startServer` 的 `generalAgent: false` 和 `directAgents`。

浏览器从独立子路径引用客户端：

```ts
import { RepaClient } from "@repa/base/client";

// capabilities 声明这个前端能显示的作答位、内容块和能提供的服务；不声明时后端不向它发询问和服务请求。
const client = await RepaClient.connect({ url, token }, { capabilities });
client.on("session.event", event => renderEvent(event));
client.on("confirm.request", async ({ id, request }) => {
  const value = await askUser(request);
  await client.call("confirm.reply", { id, value });
});
await client.call("space.open", { root: "/path/to/space" });
const agents = await client.call("agent.list", {});
// 省略 agent 时为通用 Agent；只能选 direct 为 true 的 Agent。
const session = await client.call("session.create", { agent: "general" });
await client.call("session.send", { sessionId: session.id, text: "查看这个空间" });
```

`askUser`、`renderEvent` 和 `capabilities` 由前端提供。命令确认返回布尔值，登录输入和选择返回字符串，取消返回 `null`；`display` 展示链接或进度，阅读后回复即可。登录确认只交给发起连接，其他连接不能代答。

对话里的提问走另一条通道：`ask.request` 带一份 `Item`（见[交互词汇、询问与前端服务](#交互词汇询问与前端服务)），前端用 `ask.reply` 提交、拒绝作答或关闭，`ask.closed` 通知卡片已经结束。前端声明的服务收到 `service.request`，用 `service.reply` 回结果或错误；`service.closed` 表示后端不再等待，前端应停止这次运行。

客户端不自动重放请求。连接中断或显式设置的请求超时会返回 `ConnectionError`，其中 `outcome` 为 `unknown`；重连后读取 `session.history` 与当前插件状态，再判断原操作的结果。普通调用默认等待完成，连接与初始化限时 15 秒。

`connect` 已完成 `initialize`，调用方不需要再初始化一次。用 `onConnectionChange` 订阅断线，返回的函数用于取消订阅；客户端本身不自动重连。两个前端的连接层在断线后重新向宿主取得连接信息，再连接服务，沿用现有断线提示。

Node 宿主通过独立子路径拉起服务：

```ts
import { startRepaProcess } from "@repa/base/process";

const backend = await startRepaProcess({ home: "/path/to/repa-home" });
const client = await RepaClient.connect(backend.connection);
// 宿主退出时先关闭客户端，再等待后端释放空间和会话。
await client.close();
await backend.close();
```

共享入口启动构建后的 `repa-base serve`，读取 stdout 的连接信息，不写连接文件。`plugins` 传入插件构建目录，`generalAgent: false` 关掉通用 Agent，分别对应 CLI 的 `--plugin` 和 `--no-general-agent`；插件由构建后的 CLI 检查清单后直接导入，不经过 tsx。Web 开发服务器关闭和 Electron 退出时，各自等待后端收尾；客户端断开本身不关闭服务。Electron 使用 `nodeExecutable` 和 `environment` 传入自身可执行文件与 `ELECTRON_RUN_AS_NODE=1`。`closed` 可用于观察进程退出，`close()` 可以重复调用并等待正常收尾；异常退出会返回错误。只有启动失败的进程回收设置 5 秒强制终止期限。这个 Node 入口不从浏览器客户端导出。

## 结构与责任

四个模块的接口在 [`space.ts`](src/space.ts)、[`agent.ts`](src/agent.ts)、[`plugins.ts`](src/plugins.ts) 和 [`protocol.ts`](src/protocol.ts)。协议服务负责装配与生命周期，插件宿主只接收空间、模型接口和事件回调，不依赖协议。Agent 库只出现在 `src/agent/` 内部。

采用一个包的子路径导出，而不是再建两个小包：`@repa/base/client` 与 `@repa/base/protocol` 的运行依赖保持浏览器可用；`@repa/base/plugin` 提供插件作者的接口类型、模型生命周期作用域、内置工具名和运行上下文（`currentRun()`），不引入空间或协议宿主。插件通过 `import type` 使用 `Plugin`、`Host`、`Tool` 等接口；`@repa/base/testing` 则提供离线测试宿主。

```text
<home>/agent/                 模型凭据、自定义模型、Agent 设置和 skills
<home>/settings.json          命令策略、最近 20 个空间、应用提示覆盖
<space>/.repa/lock/           带心跳的跨进程排他锁
<space>/.repa/format.json     底座数据格式版本，当前为 { "version": 1 }
<space>/.repa/plugin-versions/<id>.json  宿主管理的插件数据格式版本
<space>/.repa/sessions/       会话记录
<space>/.repa/history.git/    影子 Git
<space>/.repa/plugins/<id>/   插件自有数据
<space>/.repa/prompts.json    空间提示覆盖
<space>/.repa/.ignore         内容为 *，ripgrep 和 fd 从空间根目录搜索时不进 .repa/
```

每个服务当前持有一个活动空间，多个授权连接共享它。切换空间会关闭原空间的会话与插件，再释放锁。锁使用 `proper-lockfile`；进程异常退出后的陈旧锁在 30 秒后可回收，正常关闭立即释放。

写入按写入点记账。所有 Agent 的 write、edit 和插件的 `files.write` 走同一条写入路径：同一文件的写入排队（Pi 的 `withFileMutationQueue`，由装配交给空间宿主，空间宿主本身不依赖 Pi），再用 `recordPaths` 只提交这次碰到的路径。来源取当前运行的 runId 和祖先链，运行之外为插件；写入前这个路径上尚未记录的改动先记成 external。edit 在文件队列里读出最新内容再应用，锚文本还在就照常改，写回前在历史队列里核对磁盘仍是读到的内容；会话读过的文件在它上次读取之后被别人改过时，结果里加一句提示，告诉模型文件还有它没看过的改动。整文件 write 要求这个会话上一次读到的内容（读取或自己写入的结果）与磁盘一致，没读过的新文件可以直接写。查不过时不写，把文件现在的内容放进工具结果交回模型，并算作读过，模型据此重写即可通过。通用 Agent 写空间外的文件不走这条写入路径：用户确认之后直接写，基线核对照旧，但不进历史，也就不能撤回。

调度由工具集推出，不由 Agent 自己声明。带 bash 或 powershell 的运行是不透明写入者：整次包在 `space-history.record` 内，持空间写锁独占，前后整体快照记到它名下，运行结束的通知在这次提交完成后发出。它运行期间，其他写入等它结束，写入工具的等待可以随运行取消；只读的运行照常进行。它窗口里起的子运行直接写文件，算在它的快照里。其余运行不进 `record`，可以并行；同一会话一次只跑一个运行，后来的等前一个结束。加锁次序固定为空间写锁、同一文件的写入队列、历史队列。

会话内保留一个 `runId` 关联条目，`history.undoRun` 用它撤回这个运行及其全部子孙运行的写入。子会话的 `run` 条目同时记下 `parentRunId` 和 `parentSessionId`。外部编辑由监听器按变化的路径记成 external，拿不到路径时才扫描整个空间；整空间扫描只在打开空间、撤回之前和不透明运行前后进行。通知只负责唤醒插件，插件再用 `history.changes(cursor)` 拉取变化；通知在不属于任何运行的上下文里分发，插件变化处理里的写入记在插件名下。插件启动也会追赶，游标及领域状态由插件自己维护。

空间宿主在打开及每次历史提交后安排一次维护检查，等待 30 秒没有新提交后调用 `history.maintain()`。松散对象达到 1,024 个或 pack 达到 32 个才打包；失败交给 `onError` 并重新等待，关闭空间时则等待最后一次检查和维护完成后释放锁。维护与活动共用历史队列，永久保留历史，不裁剪提交或不可达对象。测量、成本和调用约定见[空间历史维护](../space-history/README.md#历史维护)。

`record` 动作持有空间写锁和历史队列，因此应先读取历史，再进入动作。动作内的 `files.write` 自动加入当前活动；显式嵌套 `history.record`，或在动作内调用 `history.list/changes`，会返回明确错误而不是死锁。插件界面方法即使只更新自己的数据目录，也会触发一次状态唤醒。

[`notes-plugin.ts`](examples/notes-plugin.ts) 演示完整插件接口：说明、工具、Agent 定义、少量 view、变化追赶、前端方法与关闭；还通过 `rewrite`、`summarize`、`organize` 演示三种模型入口，其中 `organize` 在后台运行插件声明的只读 Agent `notes-organizer`。内部 notebook 子插件由父插件构造 Host，只能通过文件接口访问 `notes/`，数据目录也落在父目录下。后台 Agent 工作的 id 就是会话 id，前端用会话事件查看进度，用 `session.abort` 取消。排队任务收到取消后不会调用模型；如果空间正被前一活动占用，取消的完成响应会等待它取得队列并收尾。队列与任务句柄都只在内存中存在。

## 编写和离线检查插件

### 构建清单与数据版本

构建目录需要同时包含 JavaScript 入口、静态清单及入口依赖的产物。下面是[笔记示例的清单](examples/repa-plugin.json)；运行 `npm run build --workspace=@repa/base` 后，示例产物位于 `packages/base/dist/examples/`。

```json
{
  "id": "notes",
  "version": "0.1.0",
  "baseVersion": "^0.1.0",
  "dataVersion": 1,
  "entry": "notes-plugin.js"
}
```

`id` 只含小写字母、数字和连字符，且以字母开头。`version` 是插件代码的 SemVer 版本，`baseVersion` 是可接受的底座 SemVer 范围；宿主以自身 `package.json` 中的版本核对。`dataVersion` 是正的安全整数，表示插件持久数据的格式。`entry` 必须是目录内的相对 `.js` 或 `.mjs` 文件，解析符号链接后也不能离开目录。缺字段、多字段、无效版本或不兼容的底座范围都会在执行入口前被拒绝。

代码版本与数据版本各自变化：只修改讲解文字可以保留数据版本，改变持久格式则需要改变数据版本。宿主打开空间时，先在独占锁内核对 `.repa/format.json`；调用 `plugin.open` 前，再核对 `.repa/plugin-versions/<id>.json` 与清单中的 `dataVersion` 是否相等。标记损坏时返回 `invalid_data_version`，版本不同则返回 `incompatible_data_version`，保留原标记和插件文件，由维护者选择兼容代码打开。具体数据内容仍由插件读取和校验。

当前重做期尚无真实用户，因此缺少标记的已有空间和插件数据会补上当前版本，不转换或改写原内容。直接向 `startServer`、`openPluginHost` 或离线测试宿主传入 `Plugin` 对象时，通过 `dataVersion` 声明版本，省略时使用初始版本 `1`；离线测试与正式宿主共用检查。父插件手动打开子插件时，由父插件管理这部分持久格式。

### 工具输出

模型需要一段工具结果时，宿主在 Pi 1.1.0 的 `tool_result` 钩子中合并检查文本，复用 Pi 的 `truncateHead`，保证最终文本连同提示不超过默认的 50 KiB、2,000 行。短结果原样保留；超限时为提示预留 512 字节与两行，并说明省略的字节数和行数，请模型缩小查询或使用原工具的分页参数。Pi 按完整行截断，首行本身过长时会整行省略。

因此，可能返回大结果的插件工具应提供自己的分页或范围参数。`data` 会作为 `details` 保持结构，供界面恢复必要元数据，不应复制正文。适配只把 `text` 放进模型可见的 `content`，截断时也不把完整结果复制到其他字段；Pi 替换 `content` 时会清掉未同步替换的 `structuredContent`。升级 SDK 时需复核 `extensions/runner`、`agent-loop` 和模型 transcript 的这条路径。相关实现见[输出限制](src/agent/output.ts)和[Agent 接入](src/agent/runtime.ts)。

### 插件接口与测试宿主

先从 `@repa/base/plugin` 导入 `Plugin`，用 `satisfies Plugin` 或类型注解约束插件入口，再运行 TypeScript 的严格检查。包内的声明由当前实现构建生成，因此类型错误直接对应当前版本的接口。参数使用 TypeBox schema；宿主在调用方法和工具前做实际校验，重复插件 id、重复工具名和覆盖内置工具也会在打开时被拒绝。

测试从 `@repa/base/testing` 创建临时宿主。它使用真实的空间文件、Git 历史、参数校验、变化订阅和插件关闭流程，只有 `Models` 被可控制的替身替换，因此普通测试不需要服务、模型凭据或网络。下面以包内的笔记插件为例：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createPluginTestHost } from "@repa/base/testing";
import { notesPlugin } from "../examples/notes-plugin.js";

test("笔记插件使用模型改写文字", async (t) => {
  const testing = await createPluginTestHost({ plugins: [notesPlugin] });
  t.after(() => testing.close());
  await testing.host.start();
  await testing.writeFile("notes/input.md", "原文");

  const reply = testing.models.expectComplete();
  reply.succeed("改写结果");
  const result = await testing.host.call("notes", "rewrite", {
    text: "原文", style: "简短",
  });
  assert.equal(result, "改写结果");
  assert.match((await reply.requested).prompt, /原文/u);
  assert.deepEqual(testing.errors, []);
});
```

`host.start()` 开始追赶变化；`writeFile()` 保存文件并等待历史与插件处理完成，不靠 watcher 的触发速度判断测试结束。你也可以从 `space.files` 和 `space.history` 核对文件及修订，从 `events` 和 `errors` 断言插件发出的事件与后台错误。

工具里的 `context.ask` 和 `host.services` 需要有人回答。`createPluginTestHost({ plugins, ask, services })` 的 `ask` 模拟用户：它收到已经补上 `version` 与 `requires` 的 `Item`，返回询问的结局，要模拟提交时调用其中的 `onSubmit` 取得插件的处理结果；`services` 模拟前端的服务。省略时两者分别以 `ask_unavailable`、`service_unavailable` 失败。直接调用 `host.tools()` 返回的工具时传入 `{ signal, callId }` 即可，`ask` 由宿主补上。

模型替身按接口分别排队。先用 `expectComplete()`、`expectStructured()` 或 `expectAgent()` 登记一次调用，再给出结果；没有安排的调用会立即报错。完成请求的 `succeed(value)` 和 `fail(error)` 可以在调用之前使用，也可以先等待 `requested`，检查请求后再决定结果。结构化结果仍按插件提供的 schema 校验。`expectAgent({ cancel: "manual" })` 返回 `cancelRequested` 和 `finish()`／`fail()`：先等取消信号，再手动结束任务，就能检查 `close()` 是否真的等待了终态。

`testing.close()` 关闭插件和空间，最后删除临时目录；打开失败也会走清理。测试执行的仍是可信本机插件代码，任意 Node 副作用、隔离以及 Agent 生成插件的加载方式属于另外的设计。

在仓库根目录运行：

```sh
npm run check --workspace=@repa/base
npm test --workspace=@repa/base
```

这两个入口分别检查实现、示例与测试的类型，并发现全部 `test/*.test.ts`。完整用例见[笔记插件测试](test/notes-plugin.test.ts)和[测试宿主测试](test/plugin-testing.test.ts)。独立插件包沿用自己的 `tsc --noEmit` 与 Node 测试入口，导入安装版本的这两个公开子路径即可。

## 声明 Agent

插件实例的 `agents()` 返回本领域的 Agent 定义，打开插件时读取一次。类型 `AgentDefinition`、`UserMessage` 与 `BUILTIN_TOOLS` 从 `@repa/base/plugin` 导入：

```ts
agents: () => [{
  id: "tutor",                            // 所有插件间唯一；general 留给通用 Agent
  description: "陪学习者练习 Python",       // 交给前端显示，也写进父 Agent 的 subagent 工具说明
  instructions: () => "你陪学习者练习 Python……", // 提示段 agent:tutor
  tools: ["course_lookup", "run_code"],    // BUILTIN_TOOLS 中除 grep 外的内置工具、ask_user 与任一插件的工具名
  subagents: ["checker"],                  // 可以启动的子 Agent
  direct: true,                            // 用户能否直接建会话，默认否
  view: async () => currentLesson(),       // view agent:tutor
  async beforeMessage(message) {           // 用户消息进入会话前的判断
    if (quizRunning()) return { status: "rejected", reason: "quiz_in_progress", message: "测验进行中，暂时不能求助" };
    if (practicing()) recordHelpRequest(message);
  },
}],
```

`currentLesson`、`quizRunning` 等由插件自己实现。宿主打开时核对定义：id 不合格或重复、引用不存在的工具或子 Agent、列了 grep、子 Agent 的工具超过父 Agent，分别以 `invalid_agent`、`invalid_agent_id`、`unknown_agent_tool`、`unknown_subagent`、`agent_tool_unavailable`、`subagent_exceeds_parent` 拒绝打开，并逆序关闭已打开的实例，空间因此打开失败。定义可以互相列为子 Agent，也可以列自己。

- **会话**：建会话或后台任务时选定 Agent，之后不能更换；Pi 只声明这个 Agent 的工具。插件 Agent 的提示只有空间段（空间路径与根目录 `AGENTS.md`）和 `agent:<id>`，view 只有 `agent:<id>`。基础说明、Skill 目录、工具清单段和各插件的说明只属于通用 Agent。
- **通用 Agent**：底座自带，id 为 `general`，带全部内置工具、`ask_user`、`subagent` 和全部插件的说明、工具与 view。它和 Claude Code 这类通用 Agent 一样调用工具，学习类的限制只加在插件定义的 Agent 上。读取和搜索沿用 Pi 的工具。写入和精确编辑在空间内照常记进历史；写空间外的文件（包括经符号链接写出去的）和命令一样，先问发起这次运行的连接，确认里写明实际写到的路径，并说明这次写入不进历史、不能撤回；Full Access 时不问。用户同意后直接写，工具结果里注明这次改动不能撤回。空间的 `.repa/` 一律不写，也不问。插件 Agent 在 `tools` 里列出 `ask_user` 才有这个工具，文件范围不变。
- **文件范围**：插件 Agent 的 read、write、edit、ls、find 只在空间内且不进 `.repa/`（不分大小写），字面路径和解析符号链接后的路径都要在范围内。find 用 Pi 的工具定义，查找本身注入 Node 内置的 `fs.glob`，不需要 fd：不读 `.gitignore`，不进入 `.repa`、`.git`、`node_modules`，不列出符号链接，以点开头的名字只有 pattern 写出这个点时才匹配，pattern 不能用 `..` 或绝对路径离开搜索目录。插件 Agent 不提供 grep：Pi 的 grep 把模型给的 `glob` 原样交给 ripgrep 的 `--glob`，会越过 `.repa/.ignore`；需要搜索内容时由插件提供自己的工具。bash 不限路径，仍按命令策略确认。
- **子 Agent**：列了 `subagents` 的会话多一个 `subagent` 工具，参数为 `agent` 和 `task`；插件工具不能使用这个名字（保留名见 `RESERVED_TOOL_NAMES`）。通用 Agent 能起自己（`general`，工具与它相同，包括 bash）和空间里定义的任何插件 Agent。一条回复里起的几个子 Agent 同时运行；子 Agent 运行命令和写空间外文件的确认，照旧发给发起这次运行的连接。子 Agent 在新会话中运行，看不到父对话，最后一条回复作为工具结果交回；父运行取消时子运行一起取消，空间关闭等待子运行结束。嵌套层数默认最多 3 层，可用 `createAgentRuntime({ agentDir, maxSubagentDepth })` 调整；这个上限是 Repa 的假设，用来挡住循环和重入失控，以后按使用调整。超过上限的启动请求作为工具错误交回父 Agent。
- **后台任务**：`host.models.runAgent({ agent, text })` 运行指定 Agent，省略 `agent` 时为通用 Agent；后台 Agent 不必能直接对话。
- **消息判断**：`beforeMessage` 收到 `{ sessionId, agent, mode, text, runId? }`，`mode` 为 `send`、`steer` 或 `followUp`，会话正在运行时带 `runId`。返回 `{ status: "rejected", reason, message, data? }` 时消息不进入会话；不返回或返回 `{ status: "accepted" }` 时照常处理。判断抛错同样不放行。后台任务和子 Agent 收到的任务不经过判断；判断期间用户取消了运行，这条消息不再投递。
- **运行上下文**：运行内的工具、view 和插件写入可以调用 `currentRun()`，取得 `{ runId, ancestorRunIds, sessionId, agent }`；运行之外返回 `undefined`。`ancestorRunIds` 由近到远：子运行的是父运行的 runId 加上父运行自己的链，根运行的为空数组。

## 交互词汇、询问与前端服务

很多插件都要向用户要一份结构化的输入：健康插件请用户填一周的打卡表，写作插件请用户在几个方案里挑一个、排定章节顺序，Agent 在动手前问清导出格式。这些输入的形状由底座统一定义在 [`interaction.ts`](src/interaction.ts)，经 `@repa/base/protocol` 和 `@repa/base/plugin` 导出，浏览器也能用，前端因此用同一套组件显示它们。一次询问的内容 `Item` 由说明内容块（`markdown`、`code`、`image`）和若干作答位（`choice`、`text`、`order`、`table`、`code`）组成，只含可以给用户看的部分；schema 都是严格对象，多带一个字段就校验不过。底座只负责把 `Item` 交给前端、收回原样的作答、检查结构；作答怎样解释、要不要记下来，由调用方决定。插件自己的界面把 `Item` 嵌进插件方法的契约，对话里的提问走底座的 `ask`。词汇另带四个纯函数：

- `contentVersion(definition)`：RFC 8785 规范化后取 SHA-256，返回 `sha256:<hex>`。调用方对完整定义计算，包括它自己保留、不给用户看的部分；值为 `undefined` 的成员视为不存在，`NaN`、日期对象等不是 JSON 的值以 `invalid_definition` 拒绝。
- `requiredCapabilities(item)`：从结构算出渲染它必须理解的能力，例如 `slot.table`、`block.code`、`markdown.math`。装饰图和 `format`、`layout`、`other` 这类可以忽略的提示不算。
- `canRender(capabilities, item)`：前端声明的 `supports` 是否覆盖 `item.requires`。
- `checkResponse(item, response)`：作答的结构检查，不解释含义。版本、作答类型、选项与行列 id、个数、长度、缩进和代码行数不合要求，或必答位空着，都返回 `problems`。`format` 的含义由调用方判断。

前端在 `initialize` 的 `capabilities` 里声明 `interaction: { vocabulary, supports }` 和 `services`，服务端按连接保存。后端据此不把前端不认识的 `Item` 交给它：`ask` 直接比对声明，插件方法从调用上下文读取。

发送方按当前词汇严格校验，前端读取时则要宽松：词汇只增不改，新版本加了字段，旧前端不能因此读不了。前端用 `readItem` 读取 `Item`，例如解析 `plugin.call` 返回的内容。认识的字段照常检查类型，类型不对时读取失败；不认识的字段丢掉；读不懂的作答位和内容块连同所在的一项丢掉，并把 `slot.<type>`、`block.<type>` 补进 `requires`。长度和个数的上限读取时不查，放宽上限的 `Item` 同样经 `requires` 拦下。这样词汇加了可以忽略的字段，旧前端照常显示；加了必须理解的特性，`canRender` 判为不能作答。`RepaClient` 收到 `ask.request` 时信封仍严格校验，`Item` 按 `readItem` 读取；`ask.reply` 的结果按同样的规则宽松读取。插件给自己的公开约定写读取函数时用 `readLenient(schema, value, fallback)`，规则相同：联合里认不出的值交给 `fallback`，例如健康插件把不认识的心情读作“未记录”；没有退路或退路返回 `undefined` 时，连同所在的一项丢掉；退路给的值必须是那个联合的成员。可空对象及数值按实际类型读取，TypeBox 枚举沿用字面量联合的读取规则。

**对话里的询问。** 工具执行上下文多了 `ask`：

```ts
async execute(input, context) {
  const outcome = await context.ask({
    item: weekCheckin(),                   // 插件自己构造的 ItemDraft，可以带算好的 version
    onSubmit: async (response) => {        // 作答通过结构检查后交给插件，二选一
      const problems = checkHours(response);
      if (problems.length > 0) return { status: "invalid", problems };        // 卡片保持打开，用户改好再交
      await saveCheckin(response);
      return { status: "accepted", message: [{ type: "markdown", text: "已记下本周打卡" }] }; // 显示在卡片上，然后关闭
    },
  });
  // outcome.action：submit（带 response）、decline（可带 message）、cancel、unsupported
}
```

`weekCheckin`、`checkHours` 和 `saveCheckin` 由插件实现。底座按词汇校验 `Item`、算出 `requires`，没有 `version` 时对公开内容计算；手写的 `requires` 与结构不符、id 重复或单元格引用不存在的列时以 `invalid_item` 拒绝。询问只发给发起这次运行的连接；它没有声明所需能力时不发送，直接得到 `unsupported`。作答先经 `checkResponse`，结构不对时前端直接收到 `invalid`，不调用 `onSubmit`。省略 `onSubmit` 时，通过结构检查就接受。`onSubmit` 在提问时的运行上下文里执行：带命令行的运行持有空间写锁等待回答，在别处写文件会和它互相等待；在这里写入则记在这次运行名下。没有发起连接时 `ask` 以 `ask_unavailable` 拒绝；运行中止、断线和空间关闭分别以 `ask_cancelled` 拒绝，`details.reason` 为 `aborted`、`disconnected`、`closed`。默认不设超时。

`ask.reply` 的结果因此只有两种：`{ status: "invalid", problems }` 时卡片保持打开，`{ status: "accepted", message? }` 时卡片显示附带的内容块后关闭；`decline`、`cancel`、`unsupported` 的结果为 `null`。

某段时间里不允许提问这类限制，由插件通过 `beforeMessage`、自己的触发时机和 Agent 定义来保证，底座不另设询问的判断入口：被 `beforeMessage` 拒收的消息不会启动运行；后台 Agent 什么时候启动、带不带 `ask_user` 由插件决定；插件可以先中止进行中的运行，在途的询问随运行一起取消。

底座内置的 `ask_user` 在结果 `details` 中保存完整的 `{ item, outcome }`，刷新后可以原样恢复卡片。问题与选项中的 Markdown 只有含 `$` 时才设置 `math: true`，要求界面支持 `markdown.math`。这个工具让 Agent 直接提问：参数是 1–4 个问题，每个问题有选项（选择）或输入方式（`text`、`longText`、`number`），多带字段由 Pi 的参数校验拒绝。回答原样交回模型，写成“问题 → 选择或填写的内容”；用户不按卡片作答时附的一句话原样交回，关闭询问、界面无法显示和断线也都写成工具结果，模型据此改用文字交流。

**插件方法。** `invoke(input, context)` 的 `context.caller.capabilities` 是发起调用的连接的声明，挑选交给前端的内容时用 `canRender` 过滤；离线测试宿主直接调用时没有 `caller`。方法可以声明 `result` schema，宿主在交回前校验，不符合时以 `invalid_plugin_result` 拒绝，方法已有的副作用和状态唤醒照常保留。

**前端服务。** `host.services.call(service, input, { signal })` 把请求交给声明了这项服务的连接：发起当前操作的连接自己声明时交给它，否则交给最近初始化、声明了这项服务的连接。输入必须是 JSON 数据，结果由调用方自己校验。工具里调用时传入 `context.signal`，运行取消时请求一起结束。失败不自动换连接重试。

| 错误码 | 含义与 `details` |
| --- | --- |
| `invalid_item` | 交给询问的 `Item` 不合词汇或结构不一致，`{ path }` 或 `{ problems }` |
| `ask_unavailable` | 当前运行没有可以作答的连接 |
| `ask_cancelled` | 询问没有得到回答就结束，`{ reason }` |
| `ask_not_found` | `ask.reply` 指向的询问不存在、已经结束或不属于这个连接 |
| `invalid_ask_reply` | `response` 只随 `submit`，`message` 只随 `decline` |
| `ask_busy` | 上一次提交还在处理 |
| `ask_submit_failed` | `onSubmit` 抛错或返回的结果不合词汇；询问保持打开 |
| `service_unavailable` | 没有连接声明这项服务，`{ service }` |
| `service_cancelled` | 请求没有得到结果就结束，`{ service, reason }` |
| `service_failed` | 前端报告失败，`message` 是前端的说明，`{ service, code }` |
| `service_request_not_found` | `service.reply` 指向的请求不存在、已经结束或不属于这个连接 |
| `invalid_service_input` | 服务输入不是 JSON 数据，`{ service }` |
| `invalid_plugin_result` | 插件方法的返回值不符合它声明的 `result`，`{ pluginId, methodName }` |

## 插件的关闭责任

宿主拥有通过 `Host.models` 发起的模型工作。开始关闭时，宿主停止接纳方法、工具、视图、模型调用和新的文件变化唤醒，先取消完成请求与后台 Agent，再等待已经接纳的调用和变化处理。`runAgent()` 还没返回句柄时也属于在途工作；拿到句柄后仍会取消，并等 `result` 到达终态，才按打开的逆序关闭插件实例。`cancel()` 已返回而 `result` 尚未结束时，关闭仍在等待。

父插件给子插件构造 Host 时，需要同时安排局部清理。[笔记示例](examples/notes-plugin.ts)调用 `createModelScope(host.models)`，得到 `{ models, close }`；对外入口从 `@repa/base/plugin` 导出。把其中的 `models` 交给子 Host 后，父插件就能在初始化失败或提前关闭子实例时，先调用作用域的 `close()` 停掉模型工作，再关闭已打开的子实例。这复用了根宿主的取消和等待实现，父插件不必再抄写一套后台任务管理。需要统一报告运行中的后台失败时，还可以给 `createModelScope` 传入第二个 `onError` 回调。

模型作用域只管理模型工作。因此，父插件手工关闭子实例前，还应先停止向它转发工具、view 和 `onChange`，并等待已有调用。`open()` 抛错前尚未交给宿主的文件句柄、子实例等资源，仍由创建它们的插件在 `catch` 中收尾；打开错误与清理错误同时发生时，两者都保留。

插件自己的通知链、订阅、定时器和其他非模型后台工作由 `PluginInstance.close()` 收尾。这个 Promise 完成表示该实例已经停稳，而不只是发出了停止信号。对不响应取消的可信代码，关闭会继续等待；这里没有强制终止进程的沙箱。

## 提示、状态与缓存

通用 Agent 的基础说明、空间根目录的 `AGENTS.md`、Skill 目录、工具说明和每个插件的说明各占一段；插件 Agent 的分段见[声明 Agent](#声明-agent)。Skill 来源限于 `<home>/agent/skills/` 和 `<space>/.repa/skills/`。有效配置按默认、应用覆盖、空间覆盖依次合成，覆盖按来源 id 对所有 Agent 生效；编辑文本、停用和恢复默认分别通过 `prompt.set/reset` 完成，插件 Agent 的职责段 id 为 `agent:<id>`。`prompt.preview` 返回指定 Agent 的有效分段和单列的 view，与运行采用同一分段装配代码。

会话已经使用过某段提示后，覆盖、恢复默认、停用、重新启用或插件说明变化，都会在下一轮附上一条变更说明，默认开启。说明标出来源和旧、新文本，按完整行省略两边完全相同的首尾部分，并明确旧规则不再适用于后续回答。它通过 Pi 的 `nextTurn` 自定义消息紧跟本轮用户消息进入上下文，系统提示本身仍走 Pi 的命名段落；用户输入原文保持不变。说明只追加一次，之后作为会话历史保留，不在每轮重复，也不为了清掉它改写稳定前缀。

比较基准直接取 Pi 当前投影中的系统段，并从 Repa 自己的来源标记读取原文，因此重新打开、分支和压缩都使用相应分支实际保存的提示，不再维护另一份提示版本表。历史中的说明类型是 `promptChange`，不会混进 view 数量。嵌入底座时可用 `createAgentRuntime({ agentDir, promptChangeNotice: false })` 关闭说明，提示段更新本身仍然生效。

插件按登记顺序打开、逆序关闭，但交给模型的插件提示和 view 按 id 排序，工具按名称排序。这样同一组插件改变登记顺序或打开耗时，也不会改变这些声明的顺序。插件 id、提示来源和工具名重复都被拒绝；工具也不能覆盖底座内置名称。

运行开始时读取一次 view，与最近的有效版本比较，变化才通过 Pi 的 `nextTurn` 队列追加。这样首轮也是先放系统提示与工具声明，再放用户消息和 view；以后删除旧 view 就不会改变稳定前缀的位置。默认每个来源累积 3 份旧版本后，在回合结束时批量清理，下一次请求使用清理后的上下文；缓存已过期时提前清理，寿命采用模型公开的 short 缓存寿命作保守判断。压缩不把旧 view 当成会话事实写入摘要，完成后补回最新一份。清理使用追加的上下文编辑记录，原始会话证据仍保留。

缓存保温使用内嵌运行时的 idle 策略，在模型声明缓存寿命、估算收益达到内置门槛时请求。每个 Agent 模型回复以及保温、压缩的 usage 都可从会话记录或事件中核对 `input`、`output`、`cacheRead`、`cacheWrite`。`input` 是非缓存输入，完整输入为 `input + cacheRead + cacheWrite`；一次压缩可能包含两个模型请求，会话条目保存其合计。Pi 把服务未提供的缓存计数映射为 0，因此判断字段是否真的被报告还需检查原始响应。真实 Codex 的用量、清理代价和保温限制见[核实报告](../../docs/research/base-real-model-check.md)。

## 协议入口

协议版本为 `2`，采用带令牌的 JSON-RPC 2.0 WebSocket。参数、响应与通知类型见 [`protocol.ts`](src/protocol.ts)。`2` 在 `initialize` 里增加可选的 `capabilities`，新增询问和服务两组消息。客户端严格校验消息的信封，所以给信封加字段要升版本；信封里的 `Item` 和内容块按词汇规则宽松读取，词汇加字段不用升协议版本。后端发来无效数据时，客户端以 4002 主动断开。

| 组 | 方法 |
| --- | --- |
| 连接 | `initialize` |
| 空间 | `space.list/open/create/close/roots/browse` |
| Agent | `agent.list` |
| 会话 | `session.list/create/history/send/steer/followUp/abort/setModel/compact/fork` |
| 确认 | `confirm.reply`，通知 `confirm.request` |
| 询问 | `ask.reply`，通知 `ask.request/closed` |
| 服务 | `service.reply`，通知 `service.request/closed` |
| 历史 | `history.list/changes/undo/undoRun` |
| 插件 | `plugin.list/call`，通知 `plugin.event` |
| 提示 | `prompt.list/set/reset/preview` |
| 模型 | `model.list/providers/getDefault/setDefault`、`auth.login/setKey/logout` |
| 设置 | `settings.get/set` |
| 反馈 | `feedback.create` |

`space.browse` 为不能取得本地路径的 Web 前端列出某个文件夹下的子文件夹，不传路径时从用户目录开始，并标出含 `.repa/` 的已有空间；它只返回名称与路径，不读取文件。Node 读不到 Windows 的隐藏属性，因此除点开头的名称外，按名称跳过 `$` 开头的目录、`ProgramData`、`AppData` 等资源管理器默认不显示的系统目录，以及用户目录中拒绝读取的兼容链接；用户自行设为隐藏的文件夹仍会显示。单次最多返回 1000 个子文件夹并以 `truncated` 标记截断，不提供翻页游标。路径错误分别返回 `invalid_path`、`not_found`、`not_directory`、`permission_denied`（`EACCES` 与 `EPERM`）和 `unavailable`。`space.roots` 给出浏览起点：Windows 通过 PowerShell 读取盘符名称，失败时退回用户目录所在的盘；其他平台只有 `/`。

`model.providers` 按 Pi 的提供方目录列出名称、登录方式（`api_key`／`oauth`，`login` 为 false 的只能在 Repa 之外配置）、当前生效的凭据类型（`configured`，包括环境变量）和是否有可由 `auth.logout` 删除的保存凭据（`stored`）；凭据状态用 `checkAuth` 当场解析，登录后立即反映。`model.getDefault` 返回新会话不指定模型时使用的模型：Pi 设置中的默认模型，未设置时为第一个可用模型，都没有时为 `null`。`model.setDefault` 写入 Pi 自己的 `defaultProvider/defaultModel`，与 Pi 会话保存默认模型是同一项，不在 Repa 设置中另存。`auth.setKey` 失败时保留 `requires_interactive_login` 等底座错误码，前端据此改走 `auth.login`；上游错误仍统一为 `auth_failed`，不返回凭据或细节。

`session.list` 按最后一条消息的时间（`updatedAt`）从新到旧排列，`preview` 是第一条用户消息的开头，取法与 Pi 的 `SessionManager.list` 相同，供前端列出会话。`model` 是会话自己保存的模型：会话建立后沿用它，`model.setDefault` 只影响之后新建的会话，换模型用 `session.setModel`。

运行增量、工具调用、usage 和起止通过 `session.event` 通知。工具结果的 `details` 同时保留在 `toolEnd.data.details` 与 `session.history` 的工具条目 `data.details` 中；结果没有 `details` 时省略该字段。`session.send` 等待整次运行；运行中的 `steer/followUp` 使用内嵌运行时的队列。无发起连接的后台命令在询问策略下无法取得授权，会被阻止；Full Access 是显式设置，不由插件自行提升。

Agent 相关的约定：

- `agent.list` 返回当前可用的 Agent：`{ id, description?, direct }`。关掉的通用 Agent 不在其中；`direct` 为 `true` 的才能直接对话。
- `session.create` 接受 `agent`，省略时为 `general`；`SessionInfo` 带 `agent`，改动前的旧会话为 `general`。会话的 Agent 之后不能更换，`session.fork` 沿用原 Agent。
- `session.create/send/steer/followUp/fork` 只对可直接对话的 Agent 开放；`session.history/abort` 对所有会话开放，前端可以查看并取消后台任务和子 Agent。`prompt.list/preview` 接受 `agent`，省略时为 `general`。
- 子 Agent 的会话同样出现在 `session.list` 中，`SessionInfo.parent` 为 `{ sessionId, runId, callId }`，分别指向父会话、父运行和父运行的 `subagent` 工具调用；用户会话省略 `parent`，前端据此筛选列表。子会话的 `runStart` 也带同一份顶层 `parent`，原有 `data: { parentRunId, parentSessionId }` 保留。父会话中 `subagent` 的结果是子 Agent 的最后回复，`details` 带子会话的 `sessionId`、`runId` 和 `agent`。
- 父关联保存在会话目录的 `<sessionId>.parent.json`，读取关联不需要加载对话记录。它与 Pi header 的 `parentSession`（fork 来源）独立；fork 使用新 id，不继承子 Agent 身份。旧会话没有关联文件时省略 `parent`。
- `history.undoRun` 接受 `{ runId }`，runId 来自 `runStart` 事件或会话中的 `run` 条目；撤回这个运行及其全部子孙运行的写入，返回与 `history.undo` 相同的 `{ revision, restored, conflicts }`，冲突按文件判断。这个运行及其子孙运行没有写过文件时返回 `nothing_to_undo`；带命令行的运行总有一条整体快照的提交，撤回它不会得到这个错误码。`history.undo` 的修订不存在时返回 `revision_not_found`，`history.changes` 的 `since` 不存在时也是。
- 关掉的 Agent 和已卸载插件的 Agent，其旧会话仍在 `session.list` 中，`session.history` 照常可读，`session.abort` 没有可取消的工作；发消息、分支、压缩和换模型返回 `agent_not_found`。

`feedback.create` 为一个会话生成问题反馈包，返回 zip 的路径和包内文件名。包里有 `description.md`（用户的说明和可选的 Agent 自述）、`sessions/` 下这个会话及其子 Agent 会话的原始记录、最近 50 条空间历史、`errors.json`（后端内存里最近 100 条错误，加上前端带来的 `clientErrors`）、`environment.json`（Repa、Node、系统版本，空间路径，命令策略和插件）和 `manifest.json`（每个文件替换了几处）。`describe` 为 `true` 时用会话的模型做一次不带工具的 `complete`，失败也照样出包，在 `description.md` 写明原因。`directory` 省略时写到 Repa home 的 `feedback/`，文件名按本地时间，不含冒号，重名时加序号。

生成前先读 `auth.json` 里保存的凭据，连同名称像凭据的环境变量的值一起逐字替换为 `[已脱敏:credential]`，再按格式替换私钥、`sk-`、GitHub 令牌、AWS key 和 Bearer 令牌。会话记录逐行解析后替换，转义过的密钥也能匹配。凭据读不到时整次失败，返回 `feedback_redaction_failed`，不写任何文件；全部内容在内存里脱敏、打包，磁盘上只出现最后的 zip。路径和系统用户名保持原样。

| 错误码 | 含义与 `details` |
| --- | --- |
| `agent_not_found` | Agent 不存在或已关掉，`{ agent }`；也用于向这类 Agent 的旧会话发消息、分支、压缩或换模型 |
| `agent_not_direct` | Agent 不能直接对话，`{ agent }` |
| `unknown_agent` | 打开空间时，装配指定的直接对话 Agent 不存在或已关掉，`{ agent }` |
| `message_rejected` | 插件拒收用户消息；`message` 是插件给用户的说明，`details` 为 `{ agent, reason, data? }`，按 `reason` 分支处理 |
| `message_check_failed` | 插件判断消息时出错，消息没有发送，`{ agent }` |
| `revision_not_found` | 修订不存在：格式不对，或不在这个空间的历史里；用于 `history.undo` 和 `history.changes`，`{ revision }` |
| `feedback_redaction_failed` | 读不到保存的凭据，无法脱敏，反馈包没有生成，`{ reason }` |
| `feedback_write_failed` | 反馈包的文件名都被占用了，`{ directory }` |
| `nothing_to_undo` | 没有可撤回的改动：`history.undoRun` 的运行及其子孙运行没有写过文件（`{ runId }`），或 `history.undo` 指向空间的初始快照（`{ revision }`） |

## 本次实现的决定与核实

- **提示段名适配**：Pi 不接受含冒号的段名。公开来源仍为 `plugin:<id>`，内部无碰撞编码；段落保留可读来源标签，对外历史转换回 Repa 来源。SDK 的完整提示渲染函数不在公共导出中，因此预览提供实际采用的命名分段，不复制 SDK 渲染器或额外创建预览会话。
- **会话创建与第一条用户消息的持久化**：Pi 0.87.1 默认延迟到首次 assistant 才写新会话，1.1.0 已改为首条 user 即落盘。底座仍先创建空文件，再用公开 `SessionManager.open` 建立 header，使会话在创建时就登记到持久目录，之后的消息走正常 SDK 追加路径。
- **回合结束编辑上下文**：真实 SDK 会话已验证 `agent_before_settle` 返回 `context_edit`，旧 view 从下一次请求中消失，原记录保留。没有修改消息对象、代理 SessionManager 或匹配内部提示字符串。
- **压缩恢复**：公开 `session_compact` 钩子发生在压缩记录和上下文刷新之后、重试请求之前；在这里通过公开追加及刷新接口补回 view，兼顾手动和自动压缩路径。
- **登录映射**：真实 `ModelRuntime.login` 配合本地脚本化 OAuth 提供方，经 WebSocket 完成链接展示、选择、授权码、密文输入、持久化和登出。`auth.setKey` 使用原生 API-key 登录保存凭据；需要多步环境配置的提供方使用 `auth.login`。

## 已知限制

- **Pi 1.1.0 的 view 身份检查使用[本地补丁](../../patches/@earendil-works+pi-coding-agent+1.1.0.patch)。** SDK 重建 custom message 对象后，补丁按内容判断请求前缀是否仍然有效，并忽略顶层 `timestamp`。含 view 的实际保温以及内容变化失效均有离线 SDK 回归，见下方[升级结果](#pi-110-升级结果)。0.87.1 的[冻结核实](../../docs/research/base-real-model-check.md)中，Codex 模型目录没有缓存寿命，适配器也未传递保温所需的 1 token 输出上限，因此该次真实服务没有启动保温。1.1.0 的真实服务续期效果仍待单独核实。
- 0.87.1 的冻结核实已使用已有 Codex OAuth 验证真实请求、锁内刷新、轮换结果持久化和刷新后接续。1.1.0 本轮覆盖脚本化登录映射和持久化，真实 OAuth 刷新及首次交互登录仍待单独核实。
- 影子 Git 按所属包的规则排除 `.repa/`、用户 Git、嵌套仓库、忽略项和大文件。因此 `history.undo` 撤回空间文件，不回滚插件数据库、会话或设置。插件根据变化流更新自己的状态。
- 插件是可信本机代码，文件接口和 Agent 文件工具的路径检查不是进程沙箱。bash 不限路径，在询问模式下须确认；经 bash 写到空间外的文件不属于影子 Git 的撤回范围。
- 外部编辑器不受内部队列协调。按路径记账时，只有同一路径上恰好与写入同时发生的外部修改会算作这次写入；不透明运行期间的外部修改仍会归入该运行。空间写锁和同一文件的写入队列只在这个进程内有效。进程突然退出时，未提交内容在下次打开归为外部变化。空间历史永久保留，维护只整理对象布局。

## 验证入口与交付统计

构建目录与静态清单的检查见[产物测试](test/plugin-artifacts.test.ts)，CLI 与进程启动分别见 [CLI 测试](test/cli.test.ts)和[进程测试](test/process.test.ts)。数据版本测试覆盖无版本空间补标记、关闭重开、异版拒绝及原字节保留；[输出测试](test/tool-output.test.ts)覆盖临界值、多行、单行和中文，[Agent 测试](test/agent.test.ts)通过真实 Pi 与本地模型替身检查实际模型请求及分页续取。

```sh
npm run check --workspace=@repa/base
npm run build --workspace=@repa/space-history
npm run build --workspace=@repa/base
npm test --workspace=@repa/base
npm test --workspace=@repa/space-history
```

普通测试使用临时空间与真实 Git、WebSocket、SDK、CLI 子进程，模型服务边界为脚本化假提供方。真实模型核实独立运行，避免 `npm test` 消耗订阅额度：

```sh
npm run real-model-check --workspace=@repa/base -- --output /tmp/repa-real-check.jsonl --limit 30
```

**升级前的检查记录（`47d4d2f8b`）：** 2026-10-10 的收尾检查使用本 worktree 自有依赖、Node.js 24.20.0 和 Git 2.43.0：两个包的类型检查和构建通过，`space-history` 的 53 项测试全部通过；`base` 的 62 项测试中 61 项通过，唯一失败为原有含 view 保温回归，原因见下方[缓存补丁的基线缺口](#缓存补丁为什么仍然需要)。新增维护、宿主、用量和工具取消回归均通过，脚本 `--help` 入口通过。真实服务证据沿用冻结报告，本轮验证用真实 SDK 与离线提供方完成。

脚本先构建当前公开入口，使用临时空间和笔记插件，结果文件必须不存在。默认读取 `~/.repa/agent`，也可用 `--agent-dir` 指定。运行前关闭使用同一 Agent 目录的 Repa 进程；脚本临时调整 Agent 设置，正常收尾按原字节恢复，刷新后的凭据由 Pi 保留在原文件。恢复发生冲突时保留设置副本并报告其本机位置。`--skip-refresh` 跳过显式 OAuth 刷新检查；真实调用会使用订阅额度。

### 例行核实改用 Pi 用量记录

脚本现在直接汇总公开 `session.history` 中 Pi 保存的 usage。`input` 仍为非缓存输入，完整输入为 `input + cacheRead + cacheWrite`，命中率为 `cacheRead / 完整输入`；没有输入时命中率为 `null`。每步保留助手、压缩及保温条目的原用量，并提供同口径合计。压缩可能包含两份摘要请求，Pi 保存它们的合计，因此脚本也只报告一个压缩操作的用量。

`--limit` 的单位改为 **Pi 模型操作数**：助手消息数加压缩条目数加保温条目数，不是 HTTP 请求数。每次发送或手动压缩前检查剩余额度，自动压缩和重试关闭；一次发送或压缩等待超过 90 秒时取消会话。意外工具响应在宿主同步事件中取消，阻止工具执行与后续模型调用。Pi 额外保存的零用量取消助手消息也计入助手消息数，所以异常终态的条目数可能超过开始前预留的一个名额，但不表示多发了对应数量的请求。

OAuth 刷新不计入模型操作数。对话设置仍使用 SSE，压缩则交给 Pi 自己选择传输。锁定 Codex 目录没有缓存寿命声明，因此当前组合不会产生自动保温；idle 观察字段改为 `modelOperationsDuringIdle`，明确只统计 Pi 历史中出现的操作。

HTTP 拦截层和其测试分别删除 **425 行、435 行，共 860 行**。连同用量汇总替换、工具续轮守门和离线测试，本项新增 228 行、删除 925 行，净减少 **697 行**（相对 `d6bf108e9`，只统计核实脚本及其测试）。保留 token 用量原义所需的数据都有 Pi 记录，因此不再保留 HTTP 拦截办法。原记录中下列诊断无法从 Pi 恢复，已从新输出中移除：

- HTTP/OAuth 尝试次数、状态、耗时和被阻止的 WebSocket 次数。
- 每个压缩子请求的分项用量，以及服务端缓存字段是缺失还是明确返回 0。
- 线上 input 项数、公共前缀项数、instructions 字符数和请求中的 view 数。
- 原始响应与 Pi usage 的逐次比较，包括 `usageMatchesRaw`；新的合计不再沿用 `totalRequests` 的字段名。

失败记录中的合计仅覆盖 Pi 已保存的条目。例如，第一份压缩摘要成功、第二份失败时，Pi 不保存压缩合计，已成功子请求的用量也无法恢复。这种失败的实际 token 总数未知，缺少条目不能解释为消耗 0。前缀结构仍由既有真实 SDK 接入测试核对；例行真实脚本检查回复与状态是否匹配，不再重复采集线上请求正文。

上一轮[核实报告及冻结数据](../../docs/research/base-real-model-check.md)保留原貌，其中 HTTP 请求数和传输诊断仍表示当时实际观察到的值；运行当前脚本以本节说明为准。用新的汇总口径离线重算 `run-05` 的 Pi usage，非缓存输入 **18,003**、完整输入 **33,363**、输出 **438**、缓存读 **15,360**、缓存写 **0**，命中率 **46.039%**，与原报告的 token 数一致。17 条助手消息加 1 次压缩为 18 个 Pi 模型操作；原报告的 19 次模型请求并没有被改写成 18 次请求。

离线用量测试使用锁定的真实 SDK 和 faux provider，核对两份摘要合并为一项压缩用量、汇总与 `getSessionStats()` 一致，以及工具取消后不写文件、不发续轮。当前脚本的命令入口、类型和离线行为均已验证；本轮真实服务的执行结果仍以既有冻结核实为证据。

## 底座补强验证（2026-10-11）

本次补强完成了四项变化：提示段变化后的默认一次性说明；公开的离线插件测试宿主；根宿主与父子插件共用的模型生命周期作用域及失败清理；按来源和名称排序的稳定提示、工具声明。系统提示、工具与会话仍通过 Pi 1.1.0 的公开接口装配。

### 真实模型对照

实验继续使用原来的后缀覆盖场景：先以 A 规则积累六轮回复，然后只覆盖 `plugin:notes` 的后缀为 B，观察随后八轮。通用说明组发送的用户问题与对照组完全相同，由生产底座自动追加通知；没有同时附加原实验中人工编写的 A → B 说明。为遵守本次 60 次模型操作上限，本轮省去与覆盖效果无关的缓存补探、压缩和保温观察。

| 模型与模式 | 覆盖后首次采用 B | 后缀正确轮数 | 模型操作／观测请求 | 目录费用／美元 |
| --- | ---: | ---: | ---: | ---: |
| DeepSeek Flash，无说明 | 八轮内未采用 | 0/8 | 14/14 | 0.002393676 |
| DeepSeek Flash，通用说明 | 第 1 轮 | 8/8 | 14/14 | 0.002470284 |
| DeepSeek V4 Pro，无说明 | 八轮内未采用 | 0/8 | 14/14 | 0.012587432 |
| DeepSeek V4 Pro，通用说明 | 第 1 轮 | 8/8 | 14/14 | 0.012901064 |

四组的 view 版本与回复格式都正确，错误只出现在无说明组继续使用旧后缀。两组通用说明都只在覆盖轮新增一次通知。其效果与[上一轮具体说明实验](../../docs/research/base-pi-1-real-model-check.md)相同：覆盖后的第一轮就更新，随后七轮保持。这里是两次运行的结果比较，不是同批随机化试验；本次实际验证范围是这个覆盖场景，复杂规则变化仍需要对应的使用证据。

通用说明的成本高一些。Flash 覆盖后的每次请求比对照多 126 个完整输入 token；Pro 的覆盖前输入基线少 2 个 token，覆盖后差值为 124，扣除这项基线差后同样增加 126。原具体说明约为 32 个 token。额外成本来自列出旧、新完整变化行以及通用失效说明；底座不需要理解“后缀”的语义，也不需要多调用模型。通知只写入一次，但作为历史留在后续请求中，因此不是只在覆盖轮计费。

合计 **56 次 Pi 模型操作、56 次观测请求，目录费用 0.030352456 美元**，低于 60 次和 0.5 美元上限。每组分别预留 14 次和 0.125 美元，请求失败或未知用量会停止；实际结束时未知请求及费用预留均为 0。目录每百万 token 的未命中输入／命中输入／输出价格分别为 Flash 的 0.3／0.006／1.2 美元、Pro 的 1.32／0.044／3.96 美元，按锁定目录计费，不使用时段折扣扩大预算。

四组先后运行，每组结束后都恢复 `~/.repa/agent/settings.json`，并从外部用运行前的 SHA-256 核对原字节相同。临时空间、会话及设置恢复材料随后清理。使用本 worktree 自有依赖，环境为 Linux、Node.js 22.19.0、Pi 1.1.0；项目声明的 Node 下限仍为 22.22.2。两组无说明退出码为 1，表示八轮后缀判断失败，四组流程都完整完成。

[四份冻结 JSONL](../../docs/research/results/base-hardening-20261011/)保存 token、费用、请求结构计数与回复判断，[SHA256SUMS](../../docs/research/results/base-hardening-20261011/SHA256SUMS)用于核对原始文件。工件包含计数和固定状态，凭据、完整请求与回复正文保留在模型调用路径中，不写入这些工件。

在仓库根目录复现单组，输出文件须不存在，并从新的整体授权中分配预算：

```sh
npm run real-model-check --workspace=@repa/base -- \
  --provider deepseek --model deepseek-flash \
  --scenario prompt-change --notice generic \
  --limit 14 --request-limit 14 --cost-limit 0.125 \
  --output /tmp/flash-generic.jsonl
```

对照组使用 `--notice none`，Pro 使用 `--model deepseek-v4-pro`。`--notice specific` 或兼容选项 `--change-notice` 才会使用旧实验的具体说明；默认模式现在为 `generic`。脚本不跨进程共享预算，使用同一 Agent 设置目录时要串行执行。

### 离线验证与边界

类型检查、测试和构建全部通过。根目录的 `npm run check`、`npm test`、`npm run build` 覆盖全部 workspace；最后的取消收尾修复又完成了底座构建、类型检查与全套回归。最终测试为 `space-history` 53 项、`base` 168 项、Desktop 9 项、Web 34 项，共 264 项，全部通过。

- 提示回归观察真实 SDK 的 provider 输入，覆盖修改、恢复、插件说明变化、停用和重新启用、重开、取消、压缩与分支；前缀回归在同一 root 反转插件登记顺序，实际初始 system 与工具声明保持相同。
- 插件测试覆盖重复 id／提示来源／工具名、在途方法、工具与视图、后台句柄迟到、完成请求取消、等待 Agent 终态、初始化失败清理、逆序关闭和关闭后停止接纳变化。模型工作共用 `createModelScope`，示例的局部关闭也走这条路径。
- 笔记示例测试已使用公开 `@repa/base/testing`，用真实临时文件与历史模拟变化，安排模型成功、失败、结构化错误、取消和关闭，不连接模型服务。

插件加载、隔离和安装位置仍由后续设计决定。通用通知在本次后缀场景通过了真实模型对照；其他语义变化的效果和更复杂插件的真实使用体验，留给对应场景验证。模型作用域负责取消和等待，不强制终止忽略取消的插件代码。

## Pi 1.1.0 升级评估（升级前记录）

以下保留升级前调查；实际适配和验证结果见[升级结果](#pi-110-升级结果)。评估时底座锁定 `@earendil-works/pi-ai` 和 `@earendil-works/pi-coding-agent` 0.87.1。2026-10-10 核验时，npm `latest` 为 1.1.0；npm 在 2026-10-07 22:16:26 UTC 发布，GitHub release 在当天 22:26:31 UTC 发布。调查固定使用 `v0.87.1`（`f07218c4d4bbc12bef056a7058c3dd49dfe41abe`）、`v1.1.0`（`abe508e1b89912adde45528136c3221eb69acdd7`）以及对应 npm 发布包。升级依据采用固定 tag 和发布包。[官方发布](https://github.com/earendil-works/pi/releases/tag/v1.1.0)、[npm 包](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/1.1.0)。

1.1.0 值得作为下一次小范围升级的目标。底座目前使用的原生会话、命名系统提示、队列和上下文编辑入口仍然存在，因而不需要重写 Agent 接入。新增的图像、分类、虚拟模型和 MCP/codemode 也不要求一起接入。不过，含 view 的缓存保温补丁仍有必要，新 `openai` OAuth 还需要宿主提供安装标识，因此升级不是只改两个版本号。[SDK](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/sdk.ts)、[登录实现](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/oauth/openai-chatgpt.ts#L225-L238)。

### 已使用入口的兼容性

| 底座使用入口 | 0.87.1 → 1.1.0 的核对结果 | 升级时需要处理什么 |
| --- | --- | --- |
| `createAgentSession` | `cwd`、`agentDir`、`modelRuntime`、`model`、`sessionManager`、`settingsManager`、`resourceLoader` 和 `customTools` 保留。`tools` 增加通配符与全列表 `+name`／`-name` 修饰符，普通精确名称白名单仍可使用。[SDK 参数](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/sdk.ts#L32-L106) | 当前普通工具名称可沿用。插件名称若含 `*` 或以 `+`／`-` 开头，会被新选择语法解释，接入边界应拒绝此类歧义名称。 |
| `DefaultResourceLoader` | 普通 `extensionFactories` 与 `builtin: true` 工厂分开；`noExtensions` 控制资源路径发现，普通 inline factory 仍加载。SDK 创建的 loader 不会自动提供内置 MCP/codemode 工厂。[工厂分类](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/resource-loader.ts#L371-L398)、[加载路径](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/resource-loader.ts#L677-L711) | 保留底座现有禁用资源发现、自有工厂注入方式；无需启用新内置扩展。 |
| `systemPromptOptions` 命名段落 | `customPrompt`、`sections`、`contextFiles`、`skills`、`appendSystemPrompt` 保留。新增 `hiddenTools` 用于 `prepareLoadout` 隐藏声明；命名段落仍按 transcript 当前状态生成变化条目。[提示构建](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/system-prompt.ts#L1-L74)、[段落差异](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/system-prompt.ts#L210-L251) | 沿用 `applyPromptSections`；回归修改一个来源只追加该来源，首项系统提示和工具声明保持。 |
| custom message 与 `nextTurn` | `sendCustomMessage` 签名和 `nextTurn` 队列保留。`before_agent_start` 之后构造 user 与 pending custom 消息，再把系统／工具更新放到最前面。[首轮顺序](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts#L2060-L2113)、[队列入口](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts#L2283-L2335) | 首轮和后续 view 的稳定前缀策略可沿用。`steer`／`followUp` 返回值由 `Promise<void>` 改为 `Promise<QueuedInputDisposition>`；底座当前只等待完成，可继续使用。 |
| `context_edit`、`turn_end`、`agent_before_settle` | 上下文编辑条目、boundary draft 联合以及可返回 `entries`／`continue` 的形状保留。边界仍先保存草稿，再刷新 canonical projection；`agent_before_settle` 位于重试、压缩和排队续轮之后。[边界类型](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/extensions/types.ts#L935-L1052)、[收尾](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts#L1894-L1920) | 批清旧 view 与保留原始证据的实现可沿用。`agent_settled` 新增 `aborted`，当前非穷尽事件映射不受类型破坏；需要向客户端公开该信息时再扩充协议。 |
| 缓存保温 | `CacheWarmer` 的发布 JS 在两版之间相同；`cacheContextIsCurrent` 仍逐项比较消息对象身份。[身份判断](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/sdk.ts#L369-L380) | 迁移补丁并修复下述时间戳缺口，重新生成 1.1.0 patch，不能直接删除。保留含 view 与不含 view 的保温、上下文真实变化停止保温、用量落盘回归。 |
| `ModelRuntime` 登录 | 原有三参数调用仍合法，`AuthPrompt`／`AuthEvent` 联合保持；新增可选第四参数 `LoginOptions`。新 `openai` ChatGPT OAuth 实际要求 `getDeviceId()` 返回 UUID，缺失会立即抛错。[登录委托](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/model-runtime.ts#L819-L833)、[安装标识要求](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/src/auth/oauth/openai-chatgpt.ts#L225-L238) | `Runtime.login` 传入 `getDeviceId: () => settings.getOrCreateDeviceId()`，可以同时使用 `agentName: "Repa"`。选择、密文、授权码、链接和取消映射沿用。 |
| `SettingsManager` | `create(..., { projectTrusted: false })`、`inMemory`、错误读取、`flush`、缓存模式读写保留；新增 `getSettings`、`getOrCreateDeviceId`、codemode 等设置。缓存模式仍只读全局设置，Pi 默认仍为 `streaming`。[缓存设置](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/settings-manager.ts#L1045-L1055)、[安装标识](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/settings-manager.ts#L1193-L1206) | 保留 Repa 当前默认 `idle` 与不读取空间 `.pi/settings.json` 的做法；复用原生全局安装标识，登录后核对保存与重建。 |
| `edit` 同名覆盖 | 内置定义先进入注册表，customTools 随后按名字覆盖定义和执行器；新的工具 exposure/loadout 层仍保留这一路径。[注册表](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts#L3495-L3566) | 精确 edit 无需换入口；回归全角标点、混合换行与拒绝规范化匹配。Anthropic 1.0.1 新 inline tools 改善的是会话中途重定义的缓存行为，不替代初始注册表覆盖。 |
| `tool_call` 钩子 | 返回 block 和抛错阻止执行的路径保留；新增 `parentToolCallId`，`ctx.executeTool` 嵌套调用也走同一钩子。[工具钩子](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts#L657-L690)、[嵌套执行](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts#L742-L794) | 当前 bash 确认可沿用；普通与嵌套调用都应遵守同一权限判断。当前 loader 未启用 codemode，升级不会自动增加嵌套执行路径。 |

### 缓存补丁为什么仍然需要

现有补丁只放宽 `sdk.js` 的消息前缀检查：对象身份相同，或者序列化内容相同，才视为同一份上下文。1.1.0 的 `sdk.ts:378` 和发布包 `dist/core/sdk.js:222` 仍只有前一种判断。与此同时，`SessionManager` 将 `custom_message` 投影为上下文时仍重新创建消息对象，AgentSession 在边界完成后又把投影消息装回 Agent state。因此，即使 view 的内容没有变化，保温器保存的消息对象也可能与当前对象不同，这条失效路径仍在。[custom 消息投影](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/session-manager.ts#L439-L460)、[边界刷新](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts#L938-L944)。

本轮还复现了 **0.87.1 基线补丁的时序缺口**：`sendCustomMessage` 给 view 设置 `Date.now()`，保存 custom 条目时又生成持久时间戳；两者相差 1 ms 时，内容相同的 view 在投影前后也无法通过当前 `JSON.stringify` 整对象比较。原有“含视图的会话在补丁后仍能原生缓存保温”测试因此报 `conversation context changed`，实际调用数为 1 而非 2；两次取时相同的运行则能保温。Node 22.19.0 和 24.20.0 都已复现失败，相关 runtime、view 实现和测试与任务基线 `d6bf108e9` 逐字相同。补丁仍保持当前版本，后续修复需要区分实际模型上下文与重建时产生的时间元数据，并验证真实内容变化仍会停止保温。

这说明补丁的责任仍在，而不是说明旧版本的 patch 文件可以原样套到新版本。升级时应针对新发布包重新生成补丁，并用真实 SDK 回归确认：内容相同的重建对象仍允许保温，view 被删除、替换或真实上下文前缀变化则停止保温。

### 两版之间需要关注的其他变化

已核对 0.87.1 之后的全部发布段落：0.99.0、0.99.1、0.99.2、1.0.0、1.0.1、1.0.2、1.0.3、1.0.4 和 1.1.0；同时核对 pi-ai 与 pi-agent-core 对应 changelog。[coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/CHANGELOG.md#110---2026-10-07)、[pi-ai changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/CHANGELOG.md#110---2026-10-07)、[agent-core changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/agent/CHANGELOG.md#110---2026-10-07)。

- 0.99.x 新增 MCP/codemode、工具 exposure/loadout、分类与图像模型、虚拟模型、ChatGPT OAuth，并改变工具选择与内置扩展加载。当前底座的 chat-only 模型读取保持原意，新增能力各自等待产品需求；首个 user 消息即落盘的修复则使上游新会话默认行为达到底座已有的首轮恢复要求。底座当前先创建空文件、再用 `SessionManager.open`，还承担创建时立即登记的生命周期责任，不能仅凭这项修复删除它。
- 1.0.0 从 agent-core 移除实验 harness 和 durable 子路径。底座使用 coding-agent 的 `AgentSession` 与 `SessionManager`，这些入口保留，无需因此改用 pi-durable。TUI 全屏、主题与 MCP OAuth 变化不进入当前底座 SDK 链。
- 1.0.1 删除发布包 `npm-shrinkwrap.json`，传递依赖改由消费者的锁文件约束；同时修复 `brace-expansion`，并为 Anthropic 提供保持缓存的原生 inline tool 重定义。1.0.2 增加按 thinking level 的采样配置，ModelRuntime 可以原生采用。
- 1.0.3 将 Azure provider 从 `azure-openai-responses` 改为 `azure`。使用旧 provider 的凭据、模型配置、默认模型／enabledModels／thinking-level 键和 Repa 保存的 ModelRef 要迁移；旧会话恢复需要单独核对。`azure-openai-responses` API id 与 `AZURE_OPENAI_*` 环境变量保持。OAuth 刷新在请求取消后完成并保存旋转 token 的修复也会进入 ModelRuntime。
- 1.0.4 修复隐藏工具仍出现在系统提示的问题，并扩充工具通配符／MCP 选择。当前精确白名单可沿用；相关原生 loadout 必须通过声明与缓存回归。
- 1.1.0 为消息、工具结果和执行事件增加可选 `durationMs`，为 `agent_settled` 增加 `aborted`。pi-ai 要求自定义 stream 返回 `AssistantMessageEventStream`，普通手写 `EventStream` 子类不再满足类型；底座使用原生 `ModelRuntime` 和 `fauxProvider`，不需要重写 stream。Bedrock reasoning、provider retry、Anthropic 登录端口、长提示定价和上下文限额估计等修复由原生调用链采用。缓存收益和成本变化仍需要按所用真实提供方测量。

### 升级工作范围与待验证项

建议把升级作为独立任务完成，按下面的次序收敛：

1. 明确只升级 `@repa/base`，还是同时迁移仍锁 0.87.1 的 `packages/repa` 和 `packages/organization`。只迁 base 时会有两代 Pi 副本，需要核对 npm hoist、导入解析和 patch-package 实际覆盖的包；同时迁移则需要另核两个模块的使用入口。
2. 更新目标范围内的 Pi 版本与锁文件，核对新增 `pi-codemode`／`pi-mcp` 等传递依赖；Pi 1.1.0 发布目标为 ES2024，Node 要求为 `>=22.19.0`，底座当前 `>=22.22.2` 满足。不要为了上游从源码运行方式而更换 Repa 的构建器。
3. 迁移缓存补丁并处理已复现的时间戳缺口，补上 LoginOptions 安装标识与应用名；如实际使用 Azure，再安排凭据、配置和已保存引用的迁移。
4. 在目标发布包上完成类型检查、底座与 space-history 测试、WebSocket 端到端回归；重点覆盖首轮顺序、单段更新、批清 view、默认 overflow 压缩与第一份重试、取消／队列终态、精确 edit、命令确认、登录持久化和含 view 缓存保温。

这份评估完成了发布包类型与固定源码调查，其实现和运行基准为 0.87.1。下面记录在新版本上的实际验证。


## Pi 1.1.0 升级结果

`pi-1-upgrade` 从删除旧后端的 `remove-old-backend` 提交 `6664e3a65` 开出。`@repa/base` 的两个直接 Pi 依赖现在都锁定 1.1.0；锁文件中的 `pi-agent-core`、`pi-codemode` 和 `pi-mcp` 也为 1.1.0，`npm ls` 确认没有第二代 Pi 副本。新增传递依赖保留在原生 SDK 依赖链中，底座的 loader 没有启用 MCP 或 codemode。

缓存补丁由 `patch-package` 对 1.1.0 的干净 npm 发布包重新生成，安装时只应用这一份补丁。消息比较继续忽略顶层 `timestamp`，不忽略内容、details、系统段或工具定义。安装标识则交给 Pi 的 `SettingsManager.getOrCreateDeviceId()`；`ModelRuntime.login` 接收这个回调和 `agentName: "Repa"`，返回成功前等待设置保存。

### 已使用入口的实际结果

下面每一行对应升级评估中的同一入口。测试使用锁定的真实 SDK，模型服务边界为本地 `fauxProvider`；路径指向可重复运行的测试，而不是另一份接口草案。

| 入口 | 1.1.0 上实际遇到的情况与验证 |
| --- | --- |
| `createAgentSession` | 原装配参数可沿用，插件工具实际声明和执行通过；新选择语法会解释 `*` 及开头的 `+`／`-`，因此底座以 `invalid_tool_name` 拒绝这些歧义名称。[Agent 回归](test/agent.test.ts)、[协议端到端](test/e2e.test.ts)。 |
| `DefaultResourceLoader` | 禁止路径发现仍保留自有 inline factory；临时扩展哨兵没有执行，项目 Pi Skill 没有进入提示，默认声明只含七个底座工具，未自动出现 MCP/codemode。[资源发现回归](test/agent.test.ts)。 |
| `systemPromptOptions` 命名段落 | 更改、停用和恢复一个来源都只追加该来源的变化；每份实际模型输入的初始 system 和工具声明保持不变。[提示与 view 端到端回归](test/e2e.test.ts)。 |
| custom message 与 `nextTurn` | 首轮顺序、多 view 的稳定前缀以及正常插话／追加顺序通过；`QueuedInputDisposition` 仍由底座等待后忽略。取消需要额外管理异步入队，修复及复现见下一节。[队列与首轮回归](test/agent.test.ts)。 |
| `context_edit`、`turn_end`、`agent_before_settle` | 批清、过期清理及移除来源后，下一份实际请求只包含仍有效的 view，原始历史保持；自动 overflow 的两份摘要不含 view，第一份 retry 已取得唯一的最新 view。[Agent 回归](test/agent.test.ts)、[端到端回归](test/e2e.test.ts)。 |
| 缓存保温 | 新版发布包仍只有对象身份比较，因此补丁继续保留。强制把重建消息的 timestamp 增加 60 秒仍可保温；实际内容、details、view 来源、系统段、工具或模型变化使缓存失效。含／不含 view 的真实定时保温和 usage 落盘也通过。[上下文比较回归](test/pi-cache-context.test.ts)、[实际保温回归](test/agent.test.ts)。 |
| `ModelRuntime` 登录 | 原生委托收到稳定 UUID 与 `agentName: "Repa"`；登录返回时 ID 已落盘，重建后 ID 和凭据保持。授权码、选择、密文、链接、取消及保存错误映射通过。[登录与持久设置](test/agent-settings.test.ts)、[OAuth 协议交互](test/e2e.test.ts)。 |
| `SettingsManager` | 默认 `idle` 能持久化，已有 `off`／`streaming`／`idle` 不被覆盖；底座只使用全局安装标识，项目设置不能覆盖它。损坏文件保持原字节，读写错误通过 `agent_settings` 返回。[设置回归](test/agent-settings.test.ts)。 |
| `edit` 同名覆盖 | 原生注册表仍允许底座的精确 edit 覆盖内置 edit；实际执行保留全角标点与混合换行，并拒绝规范化匹配。[精确编辑回归](test/agent.test.ts)。 |
| `tool_call` 钩子 | 普通与嵌套 bash 的允许、拒绝、确认抛错、Full Access 和确认中取消均通过，文件副作用与嵌套父调用关系一致。嵌套入口只由内部测试工厂提供，生产插件 API 没有扩展。[权限回归](test/pi-tool-permissions.test.ts)。 |

### 与原评估不同及补充核实的地方

升级评估记录的 timestamp 失败发生在 `47d4d2f8b`；后续 `fe1d7bca3` 已修正，因此本任务开始时的 0.87.1 基线已忽略 timestamp。此次迁移保留该修复，并增加确定性时间差与真实内容变化的负例，没有把旧失败记录改成成功结果。

队列返回类型虽然兼容，但原评估没有指出取消与清队列是两个动作。实际回归发现：只调用 `abort()` 后，下一次发送会消费已取消的 follow-up；只在取消开始时 `clearQueue()` 也不够，因为 Pi 在入队前会等待 input 钩子。独立复现中，两次应有的模型请求变成三次，第三次消费了旧 follow-up。底座现在持有进行中的入队操作，取消时立即阻止新输入并中止运行，等这些入队操作和空间记录收尾完成后再清队列。取消返回后才允许下一轮开始；回归分别覆盖已入队、正在入队和 input 钩子延迟三个窗口。[上游排队和取消实现](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/agent-session.ts)、[复现与回归](test/agent.test.ts)。

缓存测试还核对到 `Agent.replaceMessages` 已不在 1.1.0 的公共接口中，因此使用 SDK 文档化的 `agent.state.messages` 赋值入口重建测试上下文。生产运行仍使用既有 `SessionManager` 与 `refreshContext`，Agent 接入没有重写。

### 验证与尚待完成的工作

Node.js 24.20.0、npm 12.0.2 下，干净 `npm ci`、根构建和类型检查全部通过；测试为 `space-history` 53 项、`base` 108 项、Desktop 9 项、Web 34 项，合计 204 项，全部通过。检查使用本 worktree 自有依赖，新安装已重新应用 1.1.0 补丁。测试 home、auth 和 settings 都在临时目录，不读取个人 Agent 目录。

- 真实模型调用、ChatGPT 首次交互登录和真实服务缓存收益，等待两个分支审阅后单独核实。
- 旧 `azure-openai-responses` provider 的凭据、模型配置和已保存 ModelRef／会话尚需迁移到 `azure`；本次没有加入用户数据迁移。其他 provider 仍使用原生读取路径。
- 桌面配置已经随第一分支改为打包新底座并应用补丁，安装包及安装验证尚待执行；新底座的进程沙箱和学习插件由后续任务接续。
