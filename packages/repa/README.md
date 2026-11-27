# Repa 后端

## 概述

`@repa/repa` 是 Repa 的本机后端：把一个文件夹当作知识库，每层一段 Pi 对话，记下练习、计算复习，并经 HTTP 与 SSE 提供给界面。

## 怎么用

在仓库根目录装好依赖以后，`packages/repa/bin/repa.mjs` 就是 `repa` 命令。它先看端口 7723 上有没有后端在运行，没有就在后台启动一个，日志写到知识库的 `.repa/server.log`，然后用 Edge 的应用模式打开窗口。知识库默认在 `~/Repa`，用 `--kb <目录>` 指定别处；`--no-window` 只启动后端，不开窗口；`--install-icon` 在应用菜单和桌面放一个调用这个命令的图标。界面由 `apps/web` 构建到 `apps/web/dist` 后，由后端在同一个端口提供。

```sh
node packages/repa/bin/repa.mjs --kb ~/Repa
```

模型与登录沿用 Pi：凭据在 `~/.pi/agent/auth.json`，用 `pi auth login` 登录订阅或填 API key，`GET /api/models` 只列出已有凭据的模型。在一段对话里换的模型同时写进 `.repa/settings.json`，成为以后新对话的默认模型。

## 知识库与数据

每个文件夹是一层，Markdown 文件是卡片，文件名就是标题。名字以 `_` 或点开头的文件夹、名为 `node_modules` 的文件夹，以及含 `.git` 的文件夹（知识库的根除外）是资料，里面的 Markdown 不算卡片，文件夹也不成层；`_` 开头的文件夹、仓库和非 Markdown 文件仍列在树里。文件头的 `id`、`summary`、`keep`、`requires`、`review` 和 `moc` 都可以不写，含义见[设计记录](../../.agents/notes/proposed/architecture/2026-11-26-self-use-skeleton.md#知识库是一个文件夹)。程序只写文件头的 `id`，在一张卡片第一次被练习时写入；Agent 的改写丢了它或改了它，程序在改写完成后写回。

Repa 自己的数据在 `.repa/` 里，其中没有 Pi 的类型：

| 文件 | 内容 |
| --- | --- |
| `log.jsonl` | 练习记录，一行一个事实，只追加；格式版本 `v` 不是 1 时拒绝读取 |
| `versions/<相对路径>/<时间>-<工具调用编号>.<扩展名>` | Agent 用 `write`、`edit` 改写知识库里的文件之前留的旧版本；改写前文件不存在时扩展名是 `.absent` |
| `modes/*.md` | 任务模式，首次启动时写入讨论学习、抽查复习、整理沉淀三个 |
| `settings.json` | 改卡片与运行命令两个确认开关，以及新对话的默认模型 |
| `sessions/<层>/`、`reviews/<层>/` | 学习对话与复习对话，Pi 的格式 |

一次练习是一次出题连同它最后一条判定，或一条不经题目卡片的判定。复习的计算在 `src/review.ts`，是一个纯函数：对就是一次通过，部分对是一半的失败，错是满额的失败，交给 `@repa/learning-model` 的 HSRS 公式；同一天里同一张卡片只算一次，取最差的结果，凌晨 4 点换日。只有保持的卡片由程序计算复习，手定的 `review` 日期对任何卡片都有效，在这一天或之后有一次判定过的练习就算完成。

## 接口

后端只监听 `127.0.0.1`。Agent 能运行命令，所以它只接受来自自己页面的请求：`Host` 必须是本机地址加端口，请求带 `Origin` 时必须与它相同，写入类请求必须是 JSON。接口里的路径一律相对知识库的根，以 `/` 分隔，根是空字符串。

| 接口 | 用途 |
| --- | --- |
| `GET /api/tree`、`GET /api/folder?path=`、`GET /api/card?path=`、`GET /api/cards` | 文件夹树；一层的概况；一张卡片连同先修、链到这里的卡片、找不到目标的链接和练习记录；全部页面的元数据 |
| `PUT /api/card`、`POST /api/folder` | 保存或新建卡片（保存时带打开时的 `mtime`，文件已被改过就回 409 并带回最新内容）；新建一层 |
| `GET /api/file?path=` | 知识库里的图片等文件 |
| `GET /api/today` | 复习的建议（`due` 是手定日期已到的和到期的，`fresh` 是还没答对过的，各带总数）与最近用过的层 |
| `GET /api/sessions?folder=`、`POST /api/sessions` | 一层的学习对话与复习对话；打开（`id`）、新开（`fresh`）或接着最近的一段，`review` 给出卡片路径时新开一段复习对话 |
| `POST /api/sessions/:id/prompt`、`abort`、`compact`、`model`、`mode` | 发消息（`viewing` 是正在看的卡片）、停止、压缩、换模型、换模式 |
| `GET /api/sessions/:id/events`、`GET /api/sessions/:id/context` | 对话的 SSE 事件流；上下文占比与注入的内容 |
| `POST /api/pending/:toolCallId` | 交上题目卡片的作答（`answers`，`null` 是没有作答），或回应确认卡片（`approve`、`reason`） |
| `GET /api/change?path=&tool=`、`POST /api/revert` | 一次改动的逐行差异；把文件恢复成某个版本，返回恢复前留的版本名 |
| `GET /api/models`、`GET /api/modes`、`GET /api/settings`、`PUT /api/settings` | 有凭据的模型、模式名、确认开关 |

事件流连上时先发一份 `snapshot`，之后是增量：`item`、`delta`、`tool_end`、`pending`、`resolved`、`running` 和 `session`。类型与把事件应用到对话上的 `applyEvent` 在 `src/protocol.ts`，链接的解析在 `src/links.ts`，两者不依赖 Node，界面可以直接复用。Pi 的类型只出现在 `src/pi/` 里，知识库、练习记录、复习、地图和 HTTP 层都不导入它们，换掉 Pi 时只改这个目录。

## 对模型的影响

每段对话以所在层的文件夹为工作目录创建 Pi 会话。Pi 自带的“编程助手”提示被 `src/pi/extension.ts` 里约 10 行的学习助手提示整段换掉，它写明文件头的约定、资料在哪类文件夹里，以及五个工具 `quiz`、`grade`、`practice_history`、`kb_search`、`kb_browse` 什么时候用。Pi 逐层读到的 `AGENTS.md` 和技能只保留知识库之内的。

每一轮开始前，扩展把这一层的地图和当前模式作为三个命名段落交给 Pi：`repa_map`（位置、这一层的卡片、MOC 列进来的卡片、先修、下一层、顶层目录）、`repa_review`（这一层及以下到期的复习、最近 5 次没答好的练习）和 `repa_mode`。Pi 只在段落的文字变了时追加变了的那几段，所以只换模式或只多了一次练习时，提示缓存的前缀不变。地图各项有上限：这一层的卡片 40 张，MOC 列进来的与先修合计 20 张，下一层 20 个，到期的复习 20 张；一层 40 张卡片、每张概括二十几个字时，`repa_map` 约 1,300 个字符。

正在看的卡片的路径，以及复习时卡片全文和最近 5 次练习，作为一条不显示的消息跟在学习者的消息后面交给模型，并随对话保存。

## 已知限制与暂缓

- 小工具、MCP 与子代理不做。
- 一张卡片的改动差异以“下一份旧版本或当前文件”为改写后的内容，这次改动之后学习者在编辑器里的修改也会算进去。
- 撤回之后又撤回撤回，靠 `POST /api/revert` 返回的版本名；对话重新打开以后，界面不再记得哪次改动已经撤回。
- Agent 正在回复时发出的消息经 Pi 的 steer 插入，这条消息不附带正在看的卡片。
- 对话太短时手动压缩，Pi 回“Nothing to compact (session too small)”，接口原样返回 500。
- 地图、首页和工具每次都重新扫描整个知识库；几百张卡片时不成问题，更大时再加缓存。
