# @repa/base

## 概述

`@repa/base` 把空间文件、长期状态插件和 Agent 会话接到一个本机协议上。

## 怎么用

### 启动服务

在仓库根目录运行，要求 Node.js 22.22.2 以上与系统 Git：

```sh
npm ci
npm run build --workspace=@repa/base
npm run start --workspace=@repa/base -- serve --home /path/to/repa-home
```

服务只监听 `127.0.0.1`，stdout 输出一行 `{ "url": "ws://…/rpc", "token": "…" }`。启动方把它作为私密连接信息交给客户端，不放进公开日志。省略 `--home` 时使用 `REPA_HOME`，再回退到[系统配置目录](#应用配置目录)；`REPA_TOKEN` 可提供已有令牌，否则随机生成。`--port` 默认自动分配。收到 SIGINT、SIGTERM 时，服务等资源关闭后再退出；给出 `--close-on-stdin-end` 时，stdin 读到结尾也照此关闭。拉起服务的程序用后者请求关闭，原因有二：Windows 没有能投递给子进程的 SIGTERM，`kill` 会直接结束进程，收尾来不及进行；拉起它的程序意外退出时，stdin 也随之结束，服务同样会收尾；Windows 上由 Node 拉起的服务例外，见[接入客户端与进程宿主](#接入客户端与进程宿主)。

要加载插件，给出构建目录；例如加载包内的笔记插件，并只开放它的 Agent 供用户直接对话：

```sh
npm run start --workspace=@repa/base -- serve \
  --home /path/to/repa-home \
  --plugin "$PWD/packages/base/dist/examples" \
  --no-general-agent --direct-agent notes-organizer
```

`--plugin` 和 `--direct-agent` 都可重复。插件随产品构建和安装依赖，目录需要包含[构建清单](#构建清单与数据版本)，不接受源码文件路径。省略后两个选项时提供通用 Agent，插件 Agent 是否开放按定义中的 `direct`；指定 `--direct-agent` 后则只开放列表中的 Agent。写错 id 时打开空间返回 `unknown_agent`；若有插件停用，则从列表中去掉不可用的 Agent，空间照常打开，原因见[停用插件](#停用插件)。

### 接入客户端与进程宿主

浏览器从独立子路径引用客户端；下面的 `capabilities`、`renderEvent` 和 `askUser` 由前端提供：

```ts
import { RepaClient } from "@repa/base/client";

const client = await RepaClient.connect({ url, token }, { capabilities });
client.on("session.event", event => renderEvent(event));
client.on("confirm.request", async ({ id, request }) => {
  const value = await askUser(request);
  await client.call("confirm.reply", { id, value });
});
await client.call("space.open", { root: "/path/to/space" });
const session = await client.call("session.create", { agent: "general" });
await client.call("session.send", { sessionId: session.id, text: "查看这个空间" });
```

`connect` 返回时已完成初始化，initialize 的结果留在 `client.handshake`；其中基线的用法和断线重连见[连接与基线](#连接与基线)。`capabilities` 声明可显示的交互内容和可提供的服务，询问与确认的处理见[反向请求](#反向请求)。

Node 宿主通过独立子路径拉起构建后的服务：

```ts
import { RepaClient } from "@repa/base/client";
import { startRepaProcess } from "@repa/base/process";

const backend = await startRepaProcess({ home: "/path/to/repa-home" });
const client = await RepaClient.connect(backend.connection);
// 宿主退出时先关闭客户端，再等待后端释放空间和会话。
await client.close();
await backend.close();
```

进程入口从 stdout 读取连接信息，不写连接文件。`plugins` 接受插件构建目录，`generalAgent: false` 和 `directAgents` 对应 CLI 的装配选项；插件由构建后的 CLI 导入，不经过 tsx。嵌入同一进程时使用 `startServer`，模块边界见[包地图](../README.md)及 [`protocol.ts`](src/protocol.ts)。

客户端断开本身不关闭服务。Web 开发服务器关闭和 Electron 退出时，各自等待后端收尾；Electron 用 `nodeExecutable` 和 `environment` 传入自身可执行文件与 `ELECTRON_RUN_AS_NODE=1`。`backend.closed` 可观察进程退出。`close()` 结束后端的 stdin，请求它正常关闭，可重复调用并等待收尾完成，异常退出返回错误；宿主进程没有调用 `close()` 就退出时，结果因平台而异。Linux 和 macOS 上，后端读到 stdin 结尾，照常收尾后退出。Windows 上，Node 的 libuv 把不是 detached 的子进程放进随父进程关闭而结束的作业对象（见 libuv 1.51 的 [`uv_spawn`](https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c#L1082)），后端随宿主一起被结束，来不及收尾，但也不会留下来；它持有的空间锁最多 30 秒后视为过期，尚未提交的文件改动在下次打开空间时记为外部改动。启动失败的进程回收有 5 秒强制终止期限。进程入口依赖 Node，不从浏览器客户端导出。

### 运行检查

在仓库根目录运行类型检查和离线测试：

```sh
npm run check --workspace=@repa/base
npm test --workspace=@repa/base
```

普通测试使用临时空间、真实 Git、WebSocket、SDK 与 CLI 子进程，模型服务由本地提供方替身代替。插件测试可以直接使用[离线测试宿主](#离线测试宿主)。

真实模型核实脚本独立运行，需要可用的模型凭据与已授权额度，输出文件必须不存在：

```sh
npm run real-model-check --workspace=@repa/base -- \
  --output /tmp/repa-real-check.jsonl --limit 30
```

脚本先构建公开入口，再使用临时空间和笔记插件；默认从应用配置目录的 `agent/` 读取凭据，遵循 `REPA_HOME`，也可用 `--agent-dir` 指定。运行前关闭使用同一 Agent 目录的 Repa 进程，同目录的核实串行执行；脚本临时调整设置，正常收尾按原字节恢复，刷新后的凭据由 Pi 保留在原文件，恢复冲突时保留副本并报告位置。

`--provider` 支持 `openai-codex` 和 `deepseek`，`--model` 指定模型，`--skip-refresh` 跳过显式 OAuth 刷新检查。`--limit` 按 Pi 历史中的模型操作计数，不是 HTTP 请求数；`--request-limit` 约束请求数，DeepSeek 另用 `--cost-limit` 约束费用。每次运行须从总授权中分配额度，脚本不跨进程共享账本；场景、提示变更对照和参数限制通过 `--help` 查看。

## 空间

### 生命周期与写入

每个服务持有一个活动空间，多个授权连接共享它。切换时先停 Agent，再关插件，最后等待空间落盘并释放锁；跨进程排他锁使用 `proper-lockfile`，异常退出后的陈旧锁在 30 秒后可回收，正常关闭立即释放。

空间内的 Agent 写入和插件 `files.write` 走同一条路径：同一文件的写入排队，然后用 `recordPaths` 只提交碰到的路径。来源取当前运行的 runId 和祖先链，运行之外记为插件；写入前同一路径尚未记录的改动先记成 external。文件队列使用 Pi 的 `withFileMutationQueue`，由装配交给空间宿主，空间宿主本身不依赖 Pi。

精确编辑在文件队列里读取最新内容，再应用锚文本，写回前还会在历史队列中核对磁盘内容。会话读过的文件被别人改过时，工具结果会提醒模型；整文件写入则要求会话上一次读取或自己写入的结果与磁盘一致，未读过的新文件可以直接创建。核对失败时不写入，而是把当前内容交回模型并算作读过，模型据此重写即可。

底座用自己的精确编辑替换 Pi 的 edit，因为 Pi 在精确匹配失败后的模糊匹配会规范化整行文字，可能改变中文全角标点与弯引号，编辑还会统一全文换行。实现与维护依据见[精确编辑](src/agent/edit.ts)；升级 Pi 时应核对同名工具覆盖和这些字符的保留行为。

调度由工具集决定。带 bash 或 powershell 的运行是不透明写入者，整次放进 `space-history.record`，持空间写锁独占，前后整体快照记到它名下，提交完成后才发送运行结束通知；其子运行的写入也归入这个窗口。其他写入等待它结束，等待可随运行取消，只读运行照常进行；其余运行可以并行，同一会话的运行仍依次执行。

锁顺序固定为空间写锁、文件写入队列、历史队列。`history.record` 的动作内，`files.write` 自动加入当前活动；历史应在进入动作前读取，动作内再调用 `history.list/changes` 或显式嵌套 `record` 会返回错误，避免互相等待。

### 历史与变化追赶

空间文件历史由 [`@repa/space-history`](../space-history/README.md) 保存。每次运行在会话中留下 runId，`history.undoRun` 用它撤回该运行及全部子孙运行的写入；冲突按文件判断，没有写入时返回 `nothing_to_undo`，不透明运行则总有整体快照提交。

外部编辑器的改动由监听器按路径记成 external，拿不到路径时才扫描整个空间；整空间扫描还用于打开空间、撤回之前和不透明运行前后。历史通知只负责唤醒插件，插件再用 `history.changes(cursor)` 拉取变化，自行维护游标和领域状态；通知在运行上下文之外分发，变化处理里的写入因此记在插件名下。

插件打开后，宿主在 `start()` 中调用变化处理，先追赶已有历史。追赶期间失败会停用该插件；追赶完成后再失败，错误交给 `onError`，下一次 `flush()` 也会抛出，但插件保持可用。插件方法返回后不另查历史或唤醒所有插件；插件自有状态变化用自己的事件通知前端。

宿主在打开空间及每次历史提交后安排维护，等待 30 秒没有新提交才调用 `history.maintain()`。维护与活动共用历史队列，失败报告后重新等待，关闭时等最后一次检查和维护结束再释放锁；触发阈值、保留范围和成本见[历史维护](../space-history/README.md#历史维护)。

### 格式与版本 1

自首个测试版起，测试者的数据须保留，盘上格式的改动遵循下面三条规则，schema 有变化时先记下是否升版本及理由，见[文档规则](../../docs/AGENTS.md#持久格式与版本)。开发阶段留下的旧数据不转换。

底座只在空间尚无 `.repa/` 时创建目录与版本标记。已有目录缺少 `.repa/format.json` 时返回 `unknown_data_format`，标记损坏时为 `invalid_data_version`，版本高于当前版本时为 `incompatible_data_version`；这些检查先于锁、会话目录、搜索忽略文件和历史库的创建，因此拒绝时不写入目标空间。

持久格式遵循三条规则：

1. 新版本负责读取所有旧格式；需要改写数据时先备份，全部成功后才更新标记。
2. 遇到更新版本的数据，拒绝打开，保持盘上内容不变。
3. 只有旧版本会读错的改动才升版本；读取忽略不认识的可选字段，已知字段仍校验，写入严格按当前格式生成。

当前空间版本为 1，覆盖 `.repa/` 中的会话 jsonl、父调用关联文件、工具输出全文、影子 Git、空间提示覆盖、从备份恢复时的恢复标记，以及插件独占目录的位置。运行锁与搜索忽略文件可重建；插件目录内部的数据格式由插件管理，普通空间文件的内容由用户拥有。标记和关联文件等字段见[持久格式目录](../../docs/generated/persistence.md)，历史格式与撤销语义见[空间历史](../space-history/README.md)，会话记录的用法见[会话](#会话)，恢复标记见[备份与恢复](#备份与恢复)。

会话 jsonl 沿用 Pi 1.1.0 的公开读写入口，并保存 Repa 的 Agent 归属、模型调用归属、运行与分支关联、视图、提示变更、提示分段和上下文编辑。升级 Pi 时，需要判断会话可读性或写入语义是否使旧版本读错，再决定是否升空间版本；应用配置和 HTTP／WebSocket 协议各有自己的约定，不随空间版本变化。

`.repa/.ignore` 的内容为 `*`，使 ripgrep 和 fd 从空间根目录搜索时跳过底座数据。空间 Skill 位于 `.agents/skills/`，是 Agent 可读写、历史照常记录的普通文件；应用 Skill 位于配置目录的 `agent/skills/`。`.repa/skills/` 不加载，也不迁移。

### 应用配置目录

应用配置独立于空间，依次由 `--home`／`ServerOptions.home`、`REPA_HOME`、系统默认目录确定：

| 系统 | 默认目录 |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/repa`；未设置或不是绝对路径时用 `~/.config/repa` |
| Windows | `%APPDATA%\Repa`；缺少 `APPDATA` 时用用户目录下的 `AppData\Roaming\Repa` |
| macOS | `~/Library/Application Support/Repa` |

`agent/` 保存模型凭据、自定义模型、Agent 设置和应用 Skill，`settings.json` 保存命令策略、最近空间、应用提示覆盖与备份设置，`backups/` 保存各空间的备份。设置及提示覆盖读取时忽略未知可选字段，已知字段仍校验，接口输入和写入保持严格；加入备份设置之前保存的 `settings.json` 没有这一项，读取时取默认值。字段见[应用设置](../../docs/generated/persistence.md#app-settings)。

### 备份与恢复

学习进度全部由 `.repa/` 中的事实算出，而空间历史不记录 `.repa/`；缺陷写坏日志或学习者误删空间文件夹时，几周的进度就没了。底座因此定期把空间的 `.repa/` 复制一份，存到应用配置目录的 `backups/` 下，按空间根目录真实路径的 SHA-256 前 16 位分组。每份备份是一个目录，`data/` 是 `.repa/` 的副本，含学习记录、会话、工具输出全文、提示覆盖和历史库，所以同时保存了学习数据和空间文件的历次修订；`manifest.json` 记下空间路径、时间、种类，以及所收各文件相对 `.repa/` 的路径和复制时的大小、修改时间，字段见[备份清单](../../docs/generated/persistence.md#backup-manifest)。空间锁、恢复留下的暂存内容和写到一半的临时文件不收，复制也不跟随符号链接与目录联接，空间外的文件不会被带进备份。

打开空间以后、使用期间每隔设定的间隔、关闭空间之前，各检查一次；设置页的“立即备份”走同一条检查，各次检查依次进行。检查把 `.repa/` 中各文件的路径、大小和修改时间与最近一份备份的清单比较，没有变化就不复制，因此应用空闲时不会产生内容相同的备份，较早的备份也不会被挤掉。空间文件的改动记入历史以后，历史库随之变化，下一次检查即会备份。关闭时的检查在 Agent 与插件都停下以后、释放空间锁之前完成，关闭因此稍慢；桌面端退出时等后端收尾，也就等它结束。

备份不暂停学习与对话，每个文件按它的写法，取进程在复制时意外退出也会留下的状态。按行追加的 `.jsonl`，例如学习记录，只复制到最后一个换行符，正在追加的半行不收。会话同样只复制到最后一个换行符，但 Pi 在主线程上同步写会话，平时按行追加，新建、迁移旧版本和分支时整体重写，所以每个会话文件在一段同步代码里复制完，整体重写不会与之交错。会话引用的工具输出全文和父关联都在会话之前写完，因此先复制会话、再复制其余文件，备份中的会话所引用的文件都齐全；历史库最后在历史队列中复制，期间空间文件的写入排队等待。插件数据目录中的文件须是这几种写法之一：按行追加且以 `.jsonl` 结尾、先写临时文件再改名，或只写一次。需要数据库等其他写法的插件，须先提供自己的备份方法，其数据才能纳入备份。

每份备份先写到组内以 `.tmp-` 开头的临时目录，全部复制并同步以后才改为正式名称，所以进程中途结束不会留下不完整的备份，留下的临时目录在这一组下次备份时清理。失败时，例如磁盘已满，底座删除临时目录，已有的备份全部保留，状态里记下失败原因，下一次检查再试。成功以后，删除这个空间超出保留份数的最旧的定期备份。间隔默认 30 分钟、保留默认 5 份，学习者可以在设置页调整。

恢复在空间列表中进行，不需要先打开空间，所以空间因数据损坏打不开时也能恢复。恢复到原位置时，空间须已关闭，底座取得空间锁并全程持有。它先把当前的 `.repa/` 存为一份“恢复前”的备份，这一步失败就停下，空间保持原样；这时没有写入者，“恢复前”的备份按原始字节复制，日志不截，当前状态原样保留，以便撤回或排查。再把选中的备份复制到 `.repa/restore-staging/`，写下恢复标记 `.repa/restore.json`，把锁以外的原有内容换出到 `.repa/restore-replaced/`，换入暂存的内容，最后删除换出的内容，再删除标记。锁目录始终留在原处；空间文件保持原样，下次打开时记为外部改动。中途中断以后，打开空间见到标记即以 `restore_incomplete` 停止，需要重新恢复；重新恢复从头做起，先清理上次留下的暂存与换出的内容，中断前的状态完整保存在上一次的“恢复前”备份里，选中的备份也没有改动。“恢复前”的备份不参与轮换，学习者删除前一直保留，用它可以撤回这次恢复。两种恢复从备份复制时，来源中的目录或文件中途消失即报错、不发布：这说明所选的备份正被删除，例如原空间仍在使用、定期备份恰好把它轮换掉了，复制出的内容会缺少学习记录。

恢复到新文件夹用于空间文件夹被误删的情形。底座在选定位置的同一目录下建临时文件夹 `.<名称>.restoring`，放入备份中的 `.repa/`，再按其中历史的最近一次修订写出空间文件，这些文件与新建的目录也自底向上同步落盘，直到临时文件夹本身，完成以后才改为选定的名称；中断时只留下临时文件夹，再次恢复到同一名称时先清理它，选定的名称处不会出现不完整的空间。空间历史不收的文件，即忽略项、嵌套仓库和大文件，不在其中。Windows 上杀毒软件扫描新文件时，目录改名可能暂时失败，发布备份和换入换出都会稍候重试。

前端用下列方法接入，参数与结果的字段见[协议目录](../../docs/generated/protocol.md)：

| 方法 | 用途 |
| --- | --- |
| `settings.get`、`settings.set` | `backup.intervalMinutes`（5 至 1440 分钟）与 `backup.keep`（1 至 100 份）是检查间隔和保留份数；改了间隔，从这时起按新间隔等下一次检查 |
| `backup.status` | 活动空间最近一次成功的时间 `lastSuccess` 与上一次失败的原因 `failure`；没有打开空间时为 null |
| `backup.create` | 立即备份；没有变化时 `created` 为 false，`backup` 是已有的最近一份；失败时报 `backup_failed`，原因同时记进状态 |
| `backup.list` | 全部空间的备份，每个空间的从新到旧，带时间、大小与种类；`exists` 为 false 的空间文件夹已不存在，只能恢复到新文件夹 |
| `backup.restore` | 恢复到原位置，返回这次的“恢复前”备份；空间打开时报 `space_locked`，文件夹已不存在时报 `space_not_found` |
| `backup.restoreTo` | 恢复到新文件夹，`target` 是尚不存在的绝对路径，返回新空间的根目录；已有同名路径时报 `restore_target_exists` |
| `backup.delete` | 删除一份备份，用于删除不再需要的“恢复前”备份 |

备份新建、失败、删除或恢复以后，后端发出 `backup.updated` 通知，参数与 `backup.status` 的结果相同，带着变化所属空间的 `root`；前端据此刷新设置页和空间列表。`space.open` 报 `restore_incomplete` 时，前端应说明上次恢复没有完成，引导学习者从这个空间的备份重新恢复。

## 写插件

### 构建清单与数据版本

从 `@repa/base/plugin` 导入类型，用 `satisfies Plugin` 或类型注解约束入口，并运行 TypeScript 严格检查。这个子路径只提供插件接口、模型作用域、工具名与运行上下文，不引入空间或协议宿主；完整的 [`Plugin`](../../docs/generated/host-api.md#plugin)、[`Host`](../../docs/generated/host-api.md#host)、[`PluginInstance`](../../docs/generated/host-api.md#plugininstance) 和 [`AgentDefinition`](../../docs/generated/host-api.md#agentdefinition) 成员以生成目录为准。

构建目录需要包含 JavaScript 入口、依赖产物和 `repa-plugin.json`；例如[笔记插件清单](examples/repa-plugin.json)：

```json
{
  "id": "notes",
  "version": "0.1.0",
  "baseVersion": "^0.1.0",
  "entry": "notes-plugin.js"
}
```

宿主先静态检查清单，再导入 `default` 或 `plugin` 导出，入口 id 必须与清单一致。id 以字母开头，只含小写字母、数字和连字符；代码版本是 SemVer，底座版本必须满足声明的范围。入口必须是目录内的相对 `.js` 或 `.mjs` 文件，解析符号链接后也不能越界；缺字段、多字段、版本无效或不兼容都会在执行入口前拒绝。重复插件 id 会拒绝装配，清单检查不隔离可信本机代码。

代码版本与数据版本分开。插件在 `open` 中识别、校验自己的数据，底座不维护 `plugin-versions/`，已有目录原样保留；插件可用 `checkFormat(file, currentVersion)` 只读检查标记，它接受不高于当前版本的正整数，允许未知可选字段，错误与[空间格式](#格式与版本-1)相同。新数据由插件明确初始化。学习插件只为空目录写入版本 1 的标记，非空目录缺少标记时停用，并提示删除开发数据目录后重开空间；空间根目录的无标记 `.repa/` 仍拒绝打开。

### 使用 Host 与管理生命周期

插件用 Host 的文件和历史能力处理空间内容，把持久领域状态存到本插件独占的数据目录。方法和工具参数用 TypeBox schema 声明，宿主调用前校验；方法还可声明结果 schema，不合格时返回 `invalid_plugin_result`，已经发生的副作用仍保留。协议调用的上下文包含发起连接的能力声明，挑选前端内容时用 `canRender` 过滤，离线直接调用则可能没有 caller。

用 `host.now()` 取得 Unix 毫秒时间，默认是系统时间。嵌入时向 `createAgentRuntime({ agentDir, now })` 传入取时函数，测试也可拨动它；Pi 会话头和条目自身的时间戳仍由 Pi 管理。工具、视图和运行内的插件写入可用 `currentRun()` 取得运行归属，祖先链由近到远，工具执行期间另带 callId，运行之外返回 `undefined`。

宿主拥有通过 `Host.models` 发起的模型工作。关闭时先停止接纳新调用和变化唤醒，取消完成请求与后台 Agent，再等待已接纳的方法、工具、视图与变化处理，最后按打开的逆序关闭实例；即使 `runAgent()` 的句柄还没返回，也会等待、取消它并等 result 到达终态。

父插件构造子 Host 时，用 `createModelScope(host.models)` 管理子插件的模型工作；提前关闭或初始化失败时，先停止转发工具、视图与变化，并关闭模型作用域，等模型工作和在途调用停稳后再关闭子实例。`open` 抛错前的局部资源由插件自己释放，关闭实例还要等它自己的通知链、订阅、定时器与非模型后台工作停稳；打开与清理同时失败时保留两者的错误。

[笔记示例](examples/notes-plugin.ts) 展示说明、工具、Agent、视图、变化追赶、前端方法、三种模型入口与关闭流程。它还构造只允许访问 `notes/`、数据目录位于父目录内的 notebook 子插件，演示如何由父插件缩小 Host 的能力。

### 定义 Agent、关卡与视图

插件打开时读取一次 Agent 定义，会话创建后固定所属 Agent、工具与视图来源。宿主校验唯一 id、工具和子 Agent 引用、工具范围及保留名；声明失败会停用所属插件，无法成立的依赖插件也随之停用，空间其余部分照常工作。工具不能覆盖内置名称，名称也不能含 `*` 或以 `+`／`-` 开头，以免被 Pi 当作工具选择规则。

通用 Agent `general` 带底座内置能力及全部可用插件的工具、说明和视图；插件 Agent 只获得定义列出的工具。工具声明见[生成目录](../../docs/generated/tools.md)，Agent 定义的字段见[接口目录](../../docs/generated/host-api.md#agentdefinition)；领域运行限制由插件自己的关卡承担。

`beforeMessage` 在用户消息进入会话前判断，适用于 send、steer 和 followUp，后台任务与子 Agent 的任务不经过它。真正轮到每条消息运行时，`beforeRun` 再判断一次，包括排队消息、后台任务和子 Agent，顺序在提示与视图渲染之前；返回拒收时以 `message_rejected` 结束，不写入消息或运行标记，也不发送运行起止事件。

发送请求尚在等待时，拒收直接返回错误；已返回的排队请求通过会话 error 事件收到错误码和判断依据。声明了运行关卡的 Agent 把运行中的 steer 和 followUp 留在 Repa 队列，当前运行结束后分别检查并开始；其余 Agent 使用 Pi 的插话和追加队列。关卡抛错与视图渲染失败都按原错误报告，视图只负责把当前状态写给模型。

运行中进入受限状态时，插件先保存限制，再 `await host.abortAgent(id)` 停止自己 Agent 已加载会话中的工作，由 `beforeRun` 拦住后续消息。中止不枚举磁盘旧会话，也不阻止新的输入；运行期间的后续模型请求不会重复检查关卡。

插件 Agent 的文件工具限于空间内，字面路径与解析符号链接后的路径都要通过检查，`.repa/` 不分大小写排除，仅 read 可以读取 `tool-output/`。find 使用 Pi 工具定义和 Node `fs.glob`，不依赖 fd、不读 `.gitignore`，跳过 `.repa`、`.git`、`node_modules` 与符号链接；点开头的名字须在 pattern 中写出点，也不能用绝对路径或 `..` 越界。插件 Agent 不提供 grep，因为 Pi 把 glob 原样交给 ripgrep，会越过 `.repa/.ignore`；内容搜索由插件提供工具。

通用 Agent 可以读写空间外的文件，写入前向发起运行的连接确认实际路径，并说明不进历史、不能撤回，Full Access 时不问；写入基线仍须核对，`.repa/` 始终禁止写入。bash 不受路径限制，按命令策略确认，后台运行没有发起连接时无法在询问策略下取得授权，插件不能自行提升为 Full Access。

### 调模型与启动子任务

`host.models.complete(request)` 为调用建立一个短 Pi 会话，使用请求的 system、prompt 与模型，省略模型时用运行时默认模型。空间内的调用保存到 `.repa/sessions/`，提示、回答、用量和插件归属在同一份 jsonl；运行内的调用还记父运行关联，从工具发起时带工具调用编号。短会话不进入 `session.list`，仍可按编号查看历史，打开后只读；无空间归属的 runtime 调用仅保存在内存中。

`complete()` 返回最后一条助手消息的文本。`completeStructured(request, schema)` 则声明带原 schema 的 `submit_result` 工具，请求原生 JSON Schema 约束；参数经 Pi 转换和校验合格后，返回参数本身并立即结束工具批次。工具名写错或参数不合格时，Pi 在同一会话里把错误交给模型，允许改正一次：整个调用最多请求两次，第二次仍没有合格的提交就中止，返回 `invalid_model_output` 和最后一次的原因，例如首个错误字段的路径或写错的工具名。第一次就直接回答、不调用工具时，Pi 不再请求，同样返回 `invalid_model_output`。模型错误和取消保留各自错误码，在 Pi 开始运行之前取消也不会发出请求；短会话关闭自动重试与压缩，不整段重发。

`host.models.defaultModel()` 返回不指定模型的请求会用的模型，与运行时的 `defaultModel()` 相同；还没有可用模型时为 `undefined`，这时不指定模型的请求以 `model_required` 拒绝。它每次按当前登录与设置读取，不发起请求，插件可以据此避开离不开模型的工作，例如学习插件在没有可用模型时不出要由模型判分的题。离线测试宿主的 `ModelTestDriver` 默认有一个测试模型，`setDefaultModel(undefined)` 模拟没有可用模型。

`host.models.runAgent({ agent, text })` 启动后台任务，省略 agent 时为通用 Agent，不要求能直接对话。句柄 id 就是会话 id，前端可观察会话事件或中止；排队任务取消后不调用模型，但若正在等空间写锁，完成响应会等取得队列并收尾。任务队列与句柄仅存于内存。

Agent 定义列出子 Agent 后，模型可以用子任务工具启动它们；子 Agent 的工具不能超过父 Agent，定义允许循环与重入。子 Agent 在新会话中运行，看不到父对话，最后回复交回父 Agent，同一回复中的多个子任务并行；父运行取消时一起取消，空间关闭等它们结束，权限确认仍交给父运行的发起连接。嵌套层数默认最多 3 层，可用 `maxSubagentDepth` 调整，这是 Repa 为限制失控递归采用的假设，超限作为工具错误返回。

### 处理工具输出

插件应给模型提供分行的必要文字，把界面元数据放在 `data`，不复制正文。宿主只把 `text` 作为模型可见内容，`data` 留在工具结果 details 中，供事件与历史恢复界面。

文本超过 50 KiB 或 2,000 行时，宿主把全文保存到 `.repa/tool-output/<会话编号>/<工具调用编号>.txt`，保留开头和结尾，分别最多使用字节上限的 60% 和 20%。两端尽量按完整行截取，单行过长则在 UTF-8 字符边界切分；中间说明省略量与全文路径，模型用 read 按行续取，文件不进入空间历史。

Pi 在替换 content 时会清除未同步替换的 structuredContent，因此省略后的全文不会经另一内容字段进入模型。升级 SDK 时应复核 `extensions/runner`、`agent-loop` 到模型 transcript 的这条路径，见[输出限制](src/agent/output.ts)与[Agent 接入](src/agent/runtime.ts)。

### 导出插件数据

学习者同意时，插件可以把自己的数据导出成 zip，由学习者发给维护者，例如学习插件导出学习记录，供维护者校准学生模型。学习者要能确认发出了什么，所以先预览再写出：插件调用 `host.prepareExport({ files, sessions })`，底座读取、脱敏并在内存中打成 zip，冻结这一份，返回清单 `files`；`write(directory?)` 再把同一份 zip 写出，预览以后新增的记录不会使清单与内容不符。冻结的这一份由插件持有，保存多久由插件决定。

`files` 是插件的白名单，`name` 是包内路径。`{ name, file }` 是本插件数据目录下的顶层文件，`file` 只能是文件名：底座按读取开始时的大小读，`.jsonl` 只取到最后一个换行符，正在追加的半行不收；文件还没建立时按空文件收入。多级路径与符号链接都以 `invalid_path` 拒绝，因为中间一级目录若是指向别处的链接，只查最后一级挡不住它。`{ name, text }` 是插件生成的文字，例如版本信息。`sessions` 为真时，底座再收入空间 `.repa/sessions/` 中的全部会话记录，每个文件在一段同步代码里读完，与[备份](#备份与恢复)的取法相同；父关联与工具输出全文不收。最后加上 `manifest.json`，记下生成时间、Repa 版本、插件 id、是否收入会话，以及各文件的字节数、`.jsonl` 的记录条数和替换处数。

全部内容按[反馈包的规则](#导出反馈)替换凭据与密钥，`.jsonl` 逐行解析后替换，读不到保存的凭据时以 `export_redaction_failed` 拒绝。写出也沿用反馈包的做法：`directory` 须是绝对路径，省略时放在应用配置目录的 `exports/`，文件名为 `repa-<插件 id>-export-<本地时间>.zip`，先写同一目录中的临时文件再发布，不覆盖已有文件。

### 离线测试宿主

`@repa/base/testing` 提供真实临时空间、Git 历史、参数校验、变化订阅和关闭流程，只有 Models 换成可控制的替身，因此不需要服务、模型凭据或网络：

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

`host.start()` 追赶已有变化，失败插件见 `host.disabled()`；`writeFile()` 等文件、历史与插件处理完成，不依赖 watcher 的速度。用 `space.files`、`space.history`、`events` 和 `errors` 核对结果；到期或限时行为传入 `now: () => now`，修改闭包值即可拨动插件时钟。

模型调用前用 `expectComplete()`、`expectStructured()` 或 `expectAgent()` 登记，再 `succeed` 或 `fail`；也可先等 `requested` 检查请求后决定结果，未安排的调用立即报错，结构化结果仍按 schema 校验。`expectAgent({ cancel: "manual" })` 可先等 `cancelRequested`，再手动 `finish()` 或 `fail()`，检查关闭确实等待终态。

询问与服务通过创建宿主时的 `ask`、`services` 模拟。ask 收到已补 version 与 requires 的 Item，模拟提交时调用其中的 onSubmit；省略这两项分别以 `ask_unavailable` 和 `service_unavailable` 失败。导出默认写到临时目录的 `home/exports/`；离线宿主没有保存的凭据，只替换环境变量里的密钥和常见格式。直接执行 `host.tools()` 中的工具时传入 signal 和 callId，ask 由宿主补齐；`testing.close()` 停稳插件和空间后删除临时目录。完整用例见[笔记插件测试](test/notes-plugin.test.ts)和[测试宿主测试](test/plugin-testing.test.ts)，独立插件包使用安装版本的公开子路径及自己的类型检查、测试入口。

## 交互词汇与询问

### 组织可显示的输入

插件要用户填表、挑选方案或排列内容时，用 [`interaction.ts`](src/interaction.ts) 中的 Item 描述说明内容与作答位。词汇从 `@repa/base/protocol` 和 `@repa/base/plugin` 导出，浏览器和插件共用；Item 只放可公开显示的内容，底座检查结构并交回原样作答，含义解释与持久化由调用方负责。

发送前用 `contentVersion` 对完整定义计算版本，它按 RFC 8785 规范化后取 SHA-256；私有内容也可参与定义，但不放进公开 Item。值为 undefined 的成员视为不存在，日期、NaN 等非 JSON 值会以 `invalid_definition` 拒绝。底座为未提供版本的询问计算公开内容版本，并从结构生成 requires；手写能力与结构不符、重复 id 或无效引用都会以 `invalid_item` 拒绝。

前端在初始化时声明 `interaction.supports` 与 services，调用方用 `requiredCapabilities`、`canRender` 判断能否显示。发送方严格校验，读取方用 `readItem` 宽松读取：认识的字段检查类型，未知字段丢弃，不认识的内容块或作答位连同所在项丢弃，并把能力补进 requires，避免误作答；长度与个数上限不在读取时拒绝。词汇按只增不改的规则演进，可忽略的新字段因此不会阻断旧前端。

插件公开契约的宽松读取可用 `readLenient(schema, value, fallback)`。联合中不认识的值交给 fallback，它必须返回已知成员；没有退路或返回 undefined 时丢弃所在项，已知类型错误仍失败。`checkResponse` 检查版本、作答类型、id、个数、长度、缩进、代码行数与必答位，不解释 format 的业务含义。

### 在工具里询问

工具通过 `context.ask` 等待用户输入；下面的 Item 和业务检查由插件提供：

```ts
async execute(input, context) {
  const outcome = await context.ask({
    item: weekCheckin(),
    onSubmit: async (response) => {
      const problems = checkHours(response);
      if (problems.length > 0) return { status: "invalid", problems };
      await saveCheckin(response);
      return {
        status: "accepted",
        message: [{ type: "markdown", text: "已记下本周打卡" }],
      };
    },
  });
  // 按 outcome.action 处理提交、拒绝作答、关闭或界面不支持。
}
```

作答先过结构检查，再交给 onSubmit；invalid 让卡片保持打开，accepted 可附内容显示后关闭，省略 onSubmit 时结构通过就接受。处理抛错或结果无效以 `ask_submit_failed` 返回，询问仍可再次提交；提交处理中再次提交则为 `ask_busy`。

onSubmit 在提问时的运行上下文中执行，写入记在该运行名下。带命令行的运行持空间写锁等待回答，因此要在回调内完成属于这次运行的写入，别在另一个等待该锁的操作里保存答案。询问的路由与取消见[反向请求](#反向请求)。

底座的询问工具把完整 Item 与结局放进 details，刷新后可恢复卡片；回答或拒绝时附的一句话原样交给模型，关闭、界面无法显示和断线也作为工具结果，让模型可改用文字交流。限制何时提问由 Agent 定义、消息判断、运行关卡和插件触发时机共同承担，底座不另设询问关卡。

## 协议

### 连接与基线

底座使用带令牌的 JSON-RPC 2.0 WebSocket。方法参数、结果和通知字段统一见[协议目录](../../docs/generated/protocol.md)；协议服务负责装配与生命周期，插件宿主只接收空间、模型接口与事件回调，不依赖协议，Pi 接入集中在 `src/agent/`。

初始化响应写出前，后端在同一段同步代码中先订阅广播，再读取当前内存状态作为 baseline，立即写出响应；基线之后的事件排在响应后面，批量请求也遵循这一顺序。前端从 `client.handshake.baseline` 读到基线后才显示运行状态，再按事件更新，基线接入由 Aqua 跟进。

基线包含活动空间、停用插件，以及正在运行或有消息排队的会话，不加载磁盘旧会话。队列按处理顺序投影，先列 Pi 当前循环将消费的插话与追问，再列 Repa 的后续运行；有关卡的 Agent 则把消息留在 Repa 队列。字段见[初始化结果](../../docs/generated/protocol.md#方法initialize)。

客户端本身不自动重连或重放请求，用 `onConnectionChange` 订阅断线并按返回函数取消订阅。连接或初始化限时 15 秒，普通调用默认等完成；连接中断或显式请求超时会返回 `ConnectionError`，outcome 为 unknown。重新取得连接信息并连接后，先使用基线，再读会话历史和插件状态判断原操作的结果。

### 版本规则

协议版本为 3。后端严格校验请求，客户端读取结果与通知时先清理副本中的未知字段，再校验已声明字段，类型不对仍以 4002 断开连接；带 Item 或内容块的消息只清理信封，Item 和内容块原样按交互词汇的规则读取。增加旧前端可以忽略的字段不升版本，只有旧版本会读错的语义变化才升版本。版本检查保留，各阶段按以下规则执行：

- 开发阶段：前后端可以分别更新之前，协议版本保持为 3；盘上格式可以直接修改，开发数据可以丢弃，不写迁移，也不要求持久格式变更记录。
- 测试版：从首个测试版起，保留测试者的学习记录，执行旧数据可读、改写前备份和持久格式变更记录的规则，详见[空间格式与版本 1](#格式与版本-1)。协议版本规则自前后端可以分别更新时起执行，在此之前保持为 3。
- 首个正式版：至迟从首个正式版起执行协议版本规则，盘上格式沿用测试版已生效的规则。

### 反向请求

命令与登录确认、对话询问、前端代做服务共用一套带编号的待答机制。请求绑定接收连接，其他连接不能代答，连接断开或取消时待答项作废；回复已结束请求会失败，不会重放给重连后的客户端。

确认交给发起连接：命令返回布尔值，登录输入和选择返回字符串，取消返回 null，display 展示链接或进度后回复即可。登录通过 Pi 的 ModelRuntime，安装标识复用 `SettingsManager.getOrCreateDeviceId()`，传入应用名 Repa，并在返回成功前等设置保存；需要交互配置的提供方走登录流程，API-key 登录使用原生保存路径。

询问只发给发起运行的连接，能力不足直接返回 unsupported，没有连接时为 `ask_unavailable`。运行中止、断线或空间关闭分别以 `ask_cancelled` 结束，reason 区分 aborted、disconnected 和 closed，默认不设超时；前端按询问结果与关闭通知结束卡片。

服务优先发给声明了该服务的发起连接，否则发给最近初始化且声明了服务的连接。`host.services.call` 只传 JSON 数据，结果由调用方校验；工具中应传入 context.signal，让取消一起生效。无提供者、取消和前端失败分别为 `service_unavailable`、`service_cancelled`、`service_failed`，失败不自动换连接重试，关闭通知要求前端停止工作。

关闭空间结束命令确认、询问和服务，登录确认不属于空间；断开连接则结束该连接的全部待答请求。具体收发字段见[协议目录](../../docs/generated/protocol.md)。

### 停用插件

插件打开、能力声明或启动追赶失败时，宿主先停稳模型工作，关闭已返回的实例，再移除工具、方法、Agent、说明与视图，依赖它且无法成立的插件也停用。尚未从 open 返回的局部资源由插件自己清理，文件、历史、通用对话和其余插件照常可用。

打开或创建空间成功时同时返回停用清单，有停用项也表示空间已经打开；原因保留 `RepaFault` 的 code，其余异常为 `plugin_open_failed`，message 供用户查看。重连可查询 `plugin.disabled`，`plugin.list` 只列可用插件，调用停用插件的方法返回 `plugin_not_found`；状态在打开空间时确定，不提供自动重启或在线启停，前端提示由 Aqua 接续。

### 浏览目录

Web 前端用 `space.browse` 浏览子目录，省略路径从用户目录开始；有效的格式标记会标出空间，包括当前程序尚不能打开的更新版本，浏览只读标记。单次最多 1,000 个子目录并标记截断，不提供翻页；Windows 的隐藏目录按名称过滤，用户自行设置的隐藏属性仍可能显示。`space.roots` 在 Windows 通过 PowerShell 取盘符，失败回退用户目录所在盘，其他平台从 `/` 开始。

## 会话

### 建立、查找与接续

新会话用 Pi 1.1.0 的 `SessionManager.create(cwd, sessionDir, { id })` 建立，编号由底座传入，文件名为 `<时间戳>_<id>.jsonl`，时间戳的冒号和小数点换成连字符。会话先在内存登记，第一条用户或助手消息出现时才创建文件，并写入已缓冲的条目；未对话的会话关闭后不留 jsonl。

按编号打开只列目录、匹配 `_<id>.jsonl`，再由 Pi 读取一个文件；找不到时为 `session_not_found`，列举全部会话用 Pi 的 listAll 并合入内存会话。列表按最后消息时间倒序，预览取第一条用户消息开头；目录只属于当前空间，不按会话头 cwd 筛选，因此移动或复制空间后仍可接续，打开时 cwdOverride 使用当前根目录，会话头保持原值。

会话建立后固定 Agent，分支沿用它；只有开放直接对话的 Agent 能创建会话、收用户消息或分支，后台与子 Agent 会话仍可查看历史和中止。已停用 Agent 的旧会话也可列出和查看，发送、分支、压缩或换模型以 `agent_not_found` 拒绝。子会话的父关联文件与 Pi 的 fork 来源独立，fork 用新 id，不继承子 Agent 身份，字段见[父调用关联](../../docs/generated/persistence.md#session-parent)。

### 模型、事件与取消

新会话省略模型时使用 Pi 保存的默认模型，未设置则取首个可用模型，没有则为空；修改默认模型只影响新会话，已有会话用自己的保存值，切换需调用 `session.setModel`。提供方目录按 Pi 列出登录方式与当前凭据状态，环境变量也算已配置，登出只删除保存的凭据。

底座显式装配资源，不读取空间的 `.pi/settings.json`，也不自动发现项目扩展、提示模板或上下文文件；Skill 只来自应用与空间约定的位置。Pi 的 MCP/codemode 未启用，升级时应核对资源加载与精确工具白名单仍保持这些边界。

增量、工具调用、用量与运行起止通过会话事件传递；工具 details 同时保留在工具完成事件和会话历史中。`session.send` 等整次运行完成，steer 和 followUp 的处理取决于[运行关卡](#定义-agent关卡与视图)。

取消先阻止新输入并中止运行，等异步入队操作和空间记录收尾后再清 Pi 队列，返回后才允许下一轮开始。因为 Pi 入队前可能等待 input 钩子，只 abort 或只在取消开始时清队列都会留下稍后入队的旧消息；升级 Pi 时应核对入队、取消与清队列的这段时序。

### 导出反馈

`feedback.create` 把用户说明、可选的 Agent 自述、会话及子 Agent 原始记录、最近空间历史、前后端错误和环境信息打成 zip。describe 开启时，用会话模型做一次不带工具的生成，输入先脱敏再截断；失败或超过 120 秒仍出包并写明原因，断线或后端关闭则取消且不写文件。

生成前读取保存凭据与 Pi 解析后的实际密钥，加上名称像凭据的环境变量值，逐字替换，再处理私钥与常见令牌格式；会话逐行解析后替换，路径和系统用户名保留。凭据读不到或损坏时以 `feedback_redaction_failed` 失败，全部脱敏与打包在内存完成；默认写到应用配置目录的 feedback，先写同目录临时文件再发布，不覆盖已有包，分享前仍需核对保留的个人内容。

## 对模型的影响

- 系统提示使用 Pi 的命名段落：通用 Agent 看到基础说明、空间路径与根目录 AGENTS.md、Skill 目录、工具说明和各插件说明；插件 Agent 只看到空间段与自己的职责段。公开来源如 `plugin:<id>`、`agent:<id>` 在内部编码为 Pi 接受的无冒号段名，保留可读来源标签。
- 工具声明由会话的 Agent 定义确定，通用 Agent 汇集可用插件，插件 Agent 只取白名单。插件提示与视图按 id 排序、工具按名称排序，登记顺序和打开耗时不改变模型输入顺序；声明内容见[工具目录](../../docs/generated/tools.md)。
- 提示按默认、应用覆盖、空间覆盖依次合成，覆盖按来源 id 生效，用 `prompt.set/reset` 编辑或恢复；`prompt.preview` 返回与运行同源的命名段落及单列视图，因为 SDK 的完整提示渲染器不在公共导出中，底座不复制它。修改、停用或恢复已使用的段落后，下一轮追加一次旧、新变化行说明，比较基准取 Pi 当前投影，重开、分支和压缩使用各自分支的实际提示。
- 提示变更说明通过 nextTurn 放在本轮用户消息之后，不改用户原文或稳定前缀，随后作为历史保留，因此会占用后续输入 token。`promptChangeNotice: false` 可关闭说明，命名提示段本身仍正常更新。
- 关卡放行后，通用 Agent 读取各插件视图，插件 Agent 只读自己的 `agent:<id>` 视图，只有内容变化才经 `nextTurn` 追加在用户消息后，系统提示与工具声明维持前缀位置。每个来源默认累积 3 份旧视图后，在回合结束时通过上下文编辑批量清理，原始会话记录保留。
- 超过模型公开的 short 缓存寿命时，下一次请求前提前清理旧视图，减少重建缓存时的输入。缓存采用 Pi 默认行为，未声明寿命的模型不据此判过期；实际命中量由提供方报告。
- 压缩由 Pi 生成摘要，底座在 `session_compact` 保存摘要并刷新后、自动重试请求前补回最新视图，模型以后面的当前状态为准。底座不修改待摘要消息对象。
- token 数随提示、工具 schema、视图和历史长度变化；例如单份视图为 500 token 时，最新一版加 2 份旧版约占 1,500 token，不含消息包装。实际用量从会话记录或事件读取，完整输入为 `input + cacheRead + cacheWrite`，压缩条目可能合计两个请求。
- Pi 将提供方未报告的缓存计数记为 0，区分“未报告”和“未命中”需检查原始响应。缓存成本应按实际使用的模型与提供方核对。
- 超长插件工具输出只把开头、结尾、省略量和全文路径交给模型，不把全文复制到元数据。模型按需读取全文，输出上限与保存位置见[工具输出](#处理工具输出)。

## 已知限制与暂缓

- 提示词画板尚未实现，当前仍按来源整段覆盖；插件默认文字更新后，已覆盖的来源不会收到新文字，来源 id 改变也会使覆盖失效。画板由[底座重构记录的暂缓事项](../../.agents/notes/implemented/architecture/2026-10-29-base-refactor.md#暂缓)与 [#41](https://github.com/Utopia-V/repa/issues/41) 接续。
- `.repa/tool-output/` 中的全文文件不会自动删除；read 按行读取，超长单行只能整行读，插件应输出分行文字，让模型可以分段续取。
- 运行关卡只在消息真正开始运行时检查，运行进行中不逐次检查；插件进入受限状态时须保存限制并中止已有工作。
- 启动追赶期间，别的插件通过 runAgent 建立的会话，工具清单不会随随后发生的插件停用而更新。
- 历史只撤回空间文件，不回滚插件数据、会话或设置；忽略项、嵌套仓库及大文件的范围见[空间历史](../space-history/README.md)。历史永久保留，维护只整理对象布局。插件数据与会话由[备份](#备份与恢复)保护。
- 备份只存在本机，不能防范硬盘损坏或设备丢失；占用的磁盘空间约为 `.repa/` 的大小乘以保留份数，再加上“恢复前”的备份。数据损坏若长时间未被发现，较早的完好备份会被轮换删除，保留份数决定能回退多远。空间文件夹改名或移动以后，旧备份仍按原路径列出，新备份另起一组。
- 每次备份完整复制历史库，复制期间空间文件的写入排队等待，等待时间随历史库增大；历史库很大时，再考虑只复制变化的部分。
- 会话的取法依赖 Pi 1.1.0 在主线程上同步写会话文件，见[复制](src/backup/copy.ts)与[导出](src/feedback/export.ts)；升级 Pi 时须核对，写法改变时备份与导出的取法随之调整。
- 恢复依赖持久格式的版本规则：开发阶段不保证跨开发版本恢复，首个测试版之后，盘上格式的改动须提供转换。
- 导出与反馈包都在内存中生成整个 zip，不用 zip64：内容很大时占用相应的内存，冻结的导出在插件放下它之前一直占着；单个文件或整个包超过 4 GiB、条目超过 65,535 个时报错。
- 插件是可信本机代码，文件接口和 Agent 文件工具的路径检查不是进程沙箱；不响应取消的代码会使关闭持续等待。bash 不限路径，经它写到空间外的内容不能由空间历史撤回。
- 外部编辑器不受内部写入队列协调，同一路径上恰与写入重叠的外部修改可能归入该次写入，不透明运行期间的外部修改归入该运行；进程突然退出后，未提交内容在下次打开时记为外部变化。
- Pi 1.1.0 的真实 OAuth 刷新与首次交互登录仍需在对应提供方核实；旧 `azure-openai-responses` 提供方的凭据、模型配置及已保存模型引用和会话，尚无迁往 `azure` 的数据迁移。
