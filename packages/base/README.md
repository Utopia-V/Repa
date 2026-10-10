# Repa 底座骨架

`@repa/base` 把空间文件、长期状态插件和 Agent 会话接到一个本机协议上。它独立于旧的 `repa` 包；学习领域和前端迁接留给后续任务。

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
  --plugin "$PWD/packages/base/examples/notes-plugin.ts"
```

`--plugin` 可重复，模块导出 `default` 或 `plugin`。这些模块是本机可信代码；这里提供显式加载入口，安装、发现和版本管理不属于本次骨架。

浏览器从独立子路径引用客户端：

```ts
import { RepaClient } from "@repa/base/client";

const client = await RepaClient.connect({ url, token });
client.on("session.event", event => renderEvent(event));
client.on("confirm.request", async ({ id, request }) => {
  const value = await askUser(request);
  await client.call("confirm.reply", { id, value });
});
await client.call("space.open", { root: "/path/to/space" });
const session = await client.call("session.create", {});
await client.call("session.send", { sessionId: session.id, text: "查看这个空间" });
```

`askUser` 和 `renderEvent` 由前端实现。命令确认返回布尔值，登录输入和选择返回字符串，取消返回 `null`；`display` 展示链接或进度，阅读后回复即可。登录确认只交给发起连接，其他连接不能代答。

客户端不自动重放请求。连接中断或显式设置的请求超时会返回 `ConnectionError`，其中 `outcome` 为 `unknown`；重连后读取 `session.history` 与当前插件状态，再判断原操作的结果。普通调用默认等待完成，连接与初始化限时 15 秒。

## 结构与责任

四个模块的接口在 [`space.ts`](src/space.ts)、[`agent.ts`](src/agent.ts)、[`plugins.ts`](src/plugins.ts) 和 [`protocol.ts`](src/protocol.ts)。协议服务负责装配与生命周期，插件宿主只接收空间、模型接口和事件回调，不依赖协议。Agent 库只出现在 `src/agent/` 内部。

采用一个包的子路径导出，而不是再建两个小包：`@repa/base/client` 与 `@repa/base/protocol` 的运行依赖保持浏览器可用；`@repa/base/plugin` 提供插件作者的接口类型，不引入宿主实现。插件通过 `import type` 使用 `Plugin`、`Host`、`Tool` 等接口。

```text
<home>/agent/                 模型凭据、自定义模型、Agent 设置和 skills
<home>/settings.json          命令策略、最近 20 个空间、应用提示覆盖
<space>/.repa/lock/           带心跳的跨进程排他锁
<space>/.repa/sessions/       会话记录
<space>/.repa/history.git/    影子 Git
<space>/.repa/plugins/<id>/   插件自有数据
<space>/.repa/prompts.json    空间提示覆盖
```

每个服务当前持有一个活动空间，多个授权连接共享它。切换空间会关闭原空间的会话与插件，再释放锁。锁使用 `proper-lockfile`；进程异常退出后的陈旧锁在 30 秒后可回收，正常关闭立即释放。

一次 Agent 运行包在 `space-history.record` 内，工具写入归入这次运行；运行结束的通知在历史提交完成后发出。会话内保留一个 `runId` 关联条目，重连后可用它找到影子 Git 中对应的修订并撤回。插件独立文件写入使用自己的来源。外部编辑由监听器收集，通知只负责唤醒插件，插件再用 `history.changes(cursor)` 拉取变化。插件启动也会追赶，游标及领域状态由插件自己维护。

`record` 动作持有历史队列，因此应先读取历史，再进入动作。动作内的 `files.write` 自动加入当前活动；显式嵌套 `history.record`，或在动作内调用 `history.list/changes`，会返回明确错误而不是死锁。插件界面方法即使只更新自己的数据目录，也会触发一次状态唤醒。

[`notes-plugin.ts`](examples/notes-plugin.ts) 演示完整插件接口：说明、工具、少量 view、变化追赶、前端方法与关闭；还通过 `rewrite`、`summarize`、`organize` 演示三种模型入口。内部 notebook 子插件由父插件构造 Host，只能通过文件接口访问 `notes/`，数据目录也落在父目录下。后台 Agent 工作的 id 就是会话 id，前端用会话事件查看进度，用 `session.abort` 取消。排队任务收到取消后不会调用模型；如果空间正被前一活动占用，取消的完成响应会等待它取得队列并收尾。队列与任务句柄都只在内存中存在。

## 提示、状态与缓存

基础说明、空间根目录的 `AGENTS.md`、Skill 目录、工具说明和每个插件的说明各占一段。Skill 来源限于 `<home>/agent/skills/` 和 `<space>/.repa/skills/`。有效配置按默认、应用覆盖、空间覆盖依次合成；编辑文本、停用和恢复默认分别通过 `prompt.set/reset` 完成。`prompt.preview` 返回有效分段和单列的 view，与运行采用同一分段装配代码。

运行开始时读取一次 view，与最近的有效版本比较，变化才追加。默认每个来源累积 3 份旧版本后批量清理；缓存已过期时提前清理，寿命采用模型公开的 short 缓存寿命作保守判断。压缩不把旧 view 当成会话事实写入摘要，完成后补回最新一份。清理使用追加的上下文编辑记录，原始会话证据仍保留。

缓存保温使用内嵌运行时的 idle 策略，只在其估算收益为正且达到内置收益门槛时请求。每个 Agent 模型回复以及保温、压缩的 usage 都可从会话记录或事件中核对 `input`、`output`、`cacheRead`、`cacheWrite`。这些字段记录提供方返回的数字；本地脚本模型用于核实传输和保存，实际命中率及保温收益需要接入真实提供方后测量。

## 协议入口

协议版本为 `1`，采用带令牌的 JSON-RPC 2.0 WebSocket。参数、响应与通知类型见 [`protocol.ts`](src/protocol.ts)。

| 组 | 方法 |
| --- | --- |
| 连接 | `initialize` |
| 空间 | `space.list/open/create/close` |
| 会话 | `session.list/create/history/send/steer/followUp/abort/setModel/compact/fork` |
| 确认 | `confirm.reply`，通知 `confirm.request` |
| 历史 | `history.list/changes/undo` |
| 插件 | `plugin.list/call`，通知 `plugin.event` |
| 提示 | `prompt.list/set/reset/preview` |
| 模型 | `model.list`、`auth.login/setKey/logout` |
| 设置 | `settings.get/set` |

运行增量、工具调用、usage 和起止通过 `session.event` 通知。`session.send` 等待整次运行；运行中的 `steer/followUp` 使用内嵌运行时的队列。无发起连接的后台命令在询问策略下无法取得授权，会被阻止；Full Access 是显式设置，不由插件自行提升。

## 本次实现的决定与核实

- **提示段名适配**：Pi 0.87.1 不接受含冒号的段名。公开来源仍为 `plugin:<id>`，内部无碰撞编码；段落保留可读来源标签，对外历史转换回 Repa 来源。SDK 的完整提示渲染函数不在公共导出中，因此预览提供实际采用的命名分段，不复制 SDK 渲染器或额外创建预览会话。
- **第一条用户消息的持久化**：Pi 新会话默认延迟到首次 assistant 才写文件。这里先创建空文件，再用公开 `SessionManager.open` 让 Pi 建立自己的 header；之后 user、tool 和 assistant 均走正常 SDK 追加路径。
- **回合结束编辑上下文**：真实 SDK 会话已验证 `agent_before_settle` 返回 `context_edit`，旧 view 从下一次请求中消失，原记录保留。没有修改消息对象、代理 SessionManager 或匹配内部提示字符串。
- **压缩恢复**：公开 `session_compact` 钩子发生在压缩记录和上下文刷新之后、重试请求之前；在这里通过公开追加及刷新接口补回 view，兼顾手动和自动压缩路径。
- **登录映射**：真实 `ModelRuntime.login` 配合本地脚本化 OAuth 提供方，经 WebSocket 完成链接展示、选择、授权码、密文输入、持久化和登出。`auth.setKey` 使用原生 API-key 登录保存凭据；需要多步环境配置的提供方使用 `auth.login`。

## 已知限制

- **Pi 0.87.1 的 view 与保温冲突已复现。** 无 view 的真实 SDK 会话能触发原生保温；有 custom message view 时，SDK 每次投影重新构造消息对象，而保温检查按对象身份判断上下文是否变化，因此停止保温。本包保留原生机制，不覆盖或代理 SDK；有 view 的会话仍可在正常请求中命中提供方缓存，旧 view 按缓存 TTL 和批量阈值清理。主动保温需要上游修正这一身份判断后再核验。
- 本机 Repa 的 `agent/auth.json` 和模型凭据环境变量均不存在。此次验证使用真实 SDK 与本地假提供方；第三方 OAuth 网络回调、真实模型调用及缓存命中经济性待接入凭据后验证。
- 影子 Git 按所属包的规则排除 `.repa/`、用户 Git、嵌套仓库、忽略项和大文件。因此 `history.undo` 撤回空间文件，不回滚插件数据库、会话或设置。插件根据变化流更新自己的状态。
- 插件是可信本机代码，文件接口的路径检查不是进程沙箱。通用命令与文件工具沿用内嵌运行时的权限语义；命令在询问模式下须确认。空间外部写入不属于影子 Git 的撤回范围。
- 外部编辑器不受内部活动队列协调；恰好发生在运行期间的外部修改可能归入该运行。进程突然退出时，未提交内容在下次打开归为外部变化。空间历史的裁剪仍由 `space-history` 后续工作决定。

## 验证入口与交付统计

```sh
npm run check --workspace=@repa/base
npm run build --workspace=@repa/space-history
npm run build --workspace=@repa/base
npm test --workspace=@repa/base
npm test --workspace=@repa/space-history
```

Node.js 24.20.0 环境下，新包 50 个测试与 `space-history` 47 个测试全部通过，类型检查和声明构建通过。测试使用临时空间与真实 Git、WebSocket、SDK、CLI 子进程，模型服务边界为脚本化假提供方。浏览器客户端另通过 `platform=browser` 打包核验，依赖图不包含 Node、Agent 运行时或服务端模块。

交付统计在最终提交信息中记录，以任务开始时的分支文件树为基线。旧后端、领域包、前端与 `docs/` 保持原样。
