# 空间历史与变更流

## 概述

`@repa/space-history` 为普通空间目录保存文件历史，也能用于已有 Git 仓库的目录。它只依赖 Node.js、TypeBox 和可配置的系统 Git，不依赖现有后端包。

## 怎么用

历史位于 `<space>/.repa/history.git`；随整个空间目录一起搬家后，原有 revision 和撤销仍然有效。

```ts
import { writeFile } from "node:fs/promises";
import { openHistory } from "@repa/space-history";

const history = await openHistory("/path/to/space", {
  gitPath: "/usr/bin/git", // 默认使用 PATH 中的 git
  maxFileBytes: 10 * 1024 * 1024, // 默认上限为 10 MiB，等于上限仍保留
});

// 知道写哪些路径时，只记这些路径，归到发起写入的运行。
await history.recordPaths({ kind: "agent", runId: "run-123" }, ["notes.md"], async () => {
  await writeFile("/path/to/space/notes.md", "新笔记\n");
});
await history.recordPaths({ kind: "agent", runId: "run-456", ancestorRunIds: ["run-123"] }, ["cards.md"], async () => {
  await writeFile("/path/to/space/cards.md", "子运行写的卡片\n");
});

// 不知道会写哪些文件时，例如执行 shell，在动作前后各扫描整个空间。
const shell = await history.record({ kind: "agent", runId: "run-789" }, async () => {
  // 执行 shell 或插件代码；结束前等待它们完成写入。
});

const undoRun = await history.undoRun("run-123"); // 连同子运行 run-456
const undo = await history.undo(shell.snapshot.revision);
console.log(undoRun.conflicts, undo.restored, undo.conflicts);
```

宿主为每个空间持有一个 `history` 实例。知道写入路径的写入用 `recordPaths`：它在队列里先把这些路径上尚未记录的改动提交为 `external`，再执行回调，最后只提交这些路径，来源用调用方给的。范围外的改动不受影响，也不会被顺带提交，留给之后的快照。路径相对于空间根目录，使用 `/` 分隔，可以是文件或目录；目录包括其下全部内容，路径的某一级上级在磁盘上变成文件或符号链接时也一并记录。忽略规则、大小上限、`.repa/`、`.git` 与嵌套仓库的排除同样适用，给定路径存在却未记录时出现在 `skipped` 中。内容没有变化时不产生提交。

不透明的写入者，例如执行命令行的运行，用 `record`：它先提交整个空间已有的外部改动，再执行回调，最后保存整个空间的变化。两个入口在回调抛错时都先保存已落盘的修改，再传播异常。保存失败时，实例会保留尚未提交的来源和范围；后续调用先补完这次保存，再处理排队的外部快照或新活动，原回调不会重跑。宿主应在保存故障期间暂停其他文件写入。`record` 的 agent 空运行也有一个提交。独立的插件写入使用 `{ kind: "plugin", pluginId: "learning" }`，同样经过队列；运行内部调用的插件则直接完成写入，归属当前 run。

agent 来源可以带 `ancestorRunIds`，由近到远列出发起这个运行的各级运行，例如 `run-456` 再起的子运行写 `["run-456", "run-123"]`；根运行不写，或给空数组。同一个 `runId` 可以有任意多次提交，混用两个入口也可以。一个运行的祖先链既来自它自己的提交，也由子孙提交里的祖先链推出，各处必须一致；运行出现在自己的祖先链里时同样报错。报错时回调不执行。

回调持有队列，因此应直接操作空间文件，不在内部等待同一实例的历史方法，包括 `recordPaths`。`record` 的回调执行期间，其他 `recordPaths` 排队等它结束；子运行若在父运行的 `record` 回调里经 `recordPaths` 写入，而父运行又在等子运行，就会互相等待。宿主应先查询所需历史，再进入回调。回调必须等待其子进程和其他写入者结束，不能留下继续写文件的后台任务。`recordPaths` 的回调还应只写给定路径并尽快结束；它写到范围外的内容留给之后的快照记为 `external`。

| 接口 | 行为 |
| --- | --- |
| `openHistory(space, options?)` | 打开已有目录，初始化或复用历史，并立即保存外部改动。空空间也建立基线提交。 |
| `snapshot(source?)` | 按需扫描；默认来源为 `external`，也接受 `agent` 或 `plugin`。返回 `revision`、是否新建提交的 `committed` 和跳过项 `skipped`。直接指定来源时，调用方负责先隔离已有改动；通常优先使用 `recordPaths` 或 `record`。 |
| `snapshotPaths(paths)` | 只把给定路径上的改动提交为 `external`，路径格式和范围与 `recordPaths` 相同；没有变化时 `committed` 为 `false`。供已经知道哪些路径变了的监听使用，范围外的改动留给之后的整空间扫描。 |
| `record(source, action)` | 串行执行前置外部快照、活动及末尾快照，返回回调的 `value` 和 `snapshot`。 |
| `recordPaths(source, paths, action)` | 串行执行给定路径的前置 external 提交、活动及只含这些路径的提交，返回回调的 `value` 和 `snapshot`；没有变化时 `committed` 为 `false`。路径列表为空或含空段、`.`、`..` 时报错。 |
| `list(limit = 100)` | 从新到旧返回 revision 的 ID、父提交、来源和 ISO 时间。 |
| `changesSince(cursor)` | 返回游标之后按时间顺序排列的 revisions，每项带 `changes`，以及本次查询的终点 `revision`。`null` 从基线开始；无效或不属于当前历史的游标报 `revision_not_found`。 |
| `undo(revision)` | 撤销一个非基线提交，包括先前的 undo；返回新 revision、已恢复路径和冲突路径。全部冲突或目标为空时，也保存一个空的 undo 提交。undo 提交只包含这次恢复的路径。修订格式不对或不在这份历史里报 `revision_not_found`，目标是初始快照报 `nothing_to_undo`。 |
| `undoRun(runId)` | 撤销这个运行及其全部子孙运行的提交，两个入口留下的提交都包括在内。子孙按提交来源中的祖先链查找，中间某个运行自己没有提交也能找到。某个路径在这些运行第一次修改它之后，又被其他来源改过，包括夹在它们两次修改之间的改动，就列入冲突并保持原样；其余路径恢复到这些运行第一次修改之前的内容。冲突的其他判断与 `undo` 相同。保存一个 `{"kind":"undo","runId":"…"}` 提交，只包含恢复的路径，全部冲突时也保存。历史中没有这个运行或其子孙的提交时报 `nothing_to_undo`，不产生提交。 |
| `maintain(options?)` | 检查实际对象布局，到达门槛时前台打包；返回 `true` 表示已完成，`false` 表示未达门槛或宿主暂不允许维护。`{ force: true }` 跳过门槛，但仍遵守 Git 的维护锁。 |
| `onRevision(listener)` | 提交完成后唤醒订阅者，返回取消订阅函数。订阅者异常作为进程 warning 报告，不改变已成功的提交。 |

上表中的 `revision_not_found` 和 `nothing_to_undo` 以 `HistoryError` 抛出，调用方按 `error.code` 分支处理；其余错误是普通 `Error` 或 Git 故障。

`record` 的 agent 空运行和空的 undo 操作也保留提交，`recordPaths` 及其他无变化的快照不产生提交。来源直接保存在提交消息的 JSON 中，`list`、`changesSince` 原样返回，由此可以看出每个提交属于哪个运行及其各级祖先，例如 `{"kind":"agent","runId":"run-456","ancestorRunIds":["run-123"]}`；按修订撤销使用 `{"kind":"undo","revision":"…"}`，按运行撤销使用 `{"kind":"undo","runId":"…"}`。旧历史中的来源没有 `ancestorRunIds`，照常读取和撤销。读取提交来源时忽略未知的可选字段，已知字段仍校验；调用保存接口时严格校验来源，不允许写入未声明的字段。更早的严格读取版本无法读取新字段，格式兼容性由所属空间的[版本约定](../base/README.md#格式与版本-1)管理。本包导出这些公开数据的 TypeBox schema 和对应类型。

## 插件追赶与外部监听

通知只是唤醒信号。插件启动时就应调用 `changesSince`，之后从自身保存的 cursor 继续追赶；处理并保存插件状态成功后，再将 cursor 推进到返回的 `revision`。插件自行安排重试、幂等处理及状态和 cursor 的一致保存，宿主不替插件维护游标。

每个 revision 的 `changes` 包含 `added`、`modified`、`deleted` 或带 `previousPath` 的 `renamed`。查询保留逐提交变化，因此先新增后删除、修改后又改回原文都不会被净差异抹掉。重命名沿用 Git 的内容相似度判断；未识别出的重命名仍以删除和新增返回。路径相对于空间根目录，使用 `/` 分隔。

`watchHistory(history, watch, { debounceMs?, onError })` 接受宿主提供的监听注册函数：`watch(notify)` 注册后返回停止函数。监听知道变化的路径时调用 `notify(path)`，路径相对于空间根目录、使用 `/` 分隔；一批通知都带路径时，只用 `snapshotPaths` 记这些路径，不再扫描整个空间。这一批里只要有一次调用 `notify()` 时没带路径，就改为扫描整个空间。默认 debounce 为 100 ms，`flush()` 等待已观察到的变更保存，`close()` 停止监听并等待最后一次保存。后台保存错误交给 `onError`；调用方处理故障后，可调用 `history.snapshot()` 重试。

宿主的 watcher 必须排除 `.repa/`、`.git` 等控制目录的事件，避免保存历史反过来触发无限快照。运行期间的快照请求会排在活动之后。即使监听事件丢失，打开历史、下一次 `record` 的前置快照和撤回前的扫描仍会收集当前磁盘上的变化；两次扫描之间出现又消失的临时内容无法恢复。本包提供监听适配器，实际文件监听和后端接入由重建后的宿主负责。

## 保存与撤销的取舍

- Shadow Git 不使用索引，提交者身份写在每个提交命令里。Git 操作显式绑定 shadow 仓库，索引指向一个从不创建的文件，工作树操作另显式指定空间目录；同时隔离继承的 Git 环境、系统和全局配置、全局忽略、hooks 与自动维护。用户的 `.git`、index 和暂存内容不参与操作。
- 候选路径通过 Git 批量枚举，尊重空间内层叠的 `.gitignore`。空间根下的 `.repa/`、任意 `.git`、带 `.git` 标记的嵌套独立仓库和可识别的 bare 仓库整体排除；其中的工作树内容不受本包保护。普通大文件及特殊文件也跳过，`skipped` 给出大小、仓库或特殊类型的原因；忽略项不逐个列出。
- 变了的文件内容、树和提交由同一个 `fast-import` 流式写入，不逐文件启动 Git；没有变化时不启动它。这样既保留 CRLF、二进制和符号链接本体，也不执行 clean/smudge filter 或换行转换。实现固定使用 SHA-1 对象格式，提交中的路径均为相对路径。所用批量接口见 Git 的 [fast-import](https://git-scm.com/docs/git-fast-import/2.43.0) 和 [ls-files](https://git-scm.com/docs/git-ls-files/2.43.0) 文档。
- Windows 上每启动一个 Git 进程要数十毫秒，日常操作的耗时主要取决于启动次数。没有改动的整空间扫描只运行一次 `ls-files`，有改动再加一次 `fast-import`；插件游标已是当前版本时，变更查询不启动 Git。各项操作的启动次数上限见 [git-starts.test.ts](test/git-starts.test.ts)。
- 按路径记账不为磁盘上不存在的路径运行 `ls-files`。一个文件是否被忽略只取决于影子仓库的 `info/exclude`、空间根目录和各级上级目录中的 `.gitignore`；实例记下 Git 对单个文件的判断和当时这些忽略规则的内容，内容不变且文件名与所在目录的实际目录项大小写完全一致时沿用判断，因此同一文件再次写入只运行一次 `fast-import`。
- 撤销前先保存外部改动。此后，只要目标路径或相关父子路径被后续提交触碰过，就报告冲突；内容后来改回一样也不例外。按运行撤销时只看其他来源的提交，从这些运行第一次修改该路径之后算起。恢复前还检查当前内容、忽略规则和路径边界。重命名两端及文件/目录转换成组处理，有冲突的组保持原样，独立路径仍可恢复。
- 恢复只写目标提交的路径。文件与目录互换时，只有待清理目录中的文件全都属于本次可撤销新增内容，才允许恢复，因而额外的忽略文件也不会被删除。常规文件先写同目录临时文件再原子替换，避免写入失败先丢失当前文件。祖先符号链接作为冲突处理，不沿链接向空间外恢复。
- 新的忽略规则、大小上限或嵌套仓库边界可能让旧条目离开历史覆盖范围，变更流因此会报告 `deleted`，但磁盘上的文件未必删除。插件应据此重新读取当前状态；撤销也会检查真实文件，不按历史树中的缺席盲删。

## 历史维护

历史永久保留，维护只整理对象的存放方式。小批量文本修改经 `fast-import` 导入后通常仍成为松散对象，大批量导入则留下 pack。因此，`maintain()` 用 `git count-objects -v` 同时检查这两种积累：松散对象达到 1,024 个，或 pack 达到 32 个，就运行一次前台维护。检查依据来自仓库本身，重开空间也能发现旧的积累，不需要另存提交计数或完成标记。

当前单文件修改通常增加 blob、tree、commit 三个对象，松散对象门槛约对应几百次修改，既不在每次提交后打包，也避免积累几千次后才整库整理。32 个 pack 是大批量导入路径的补充门槛，相关合并与保留行为由真实 Git 测试覆盖。这些是工程默认值，后续可按更大空间和二进制资产的实际维护延迟调整。

维护与快照、撤销和 `record` 共用实例队列。宿主应在动作之外调用 `await history.maintain()`；它会等前面的活动保存完，再完成打包，后续历史操作才继续。失败会拒绝 Promise，下一次调用仍可重试。宿主还可以传入同步 `canRun` 回调，在真正开始打包前重新确认持有空间锁；回调返回 `false` 时跳过本次维护。这个入口不会自行安装定时任务，`@repa/base` 的[空间宿主](../base/src/space/space.ts)在打开时安排一次检查，每次新提交重新等待 30 秒；这段时间没有新提交才调用维护。后台失败交给 `onError` 并重新等待，空间关闭则等待最终检查和维护完成后才释放空间锁。

实际执行的维护参数为：

```sh
git -c gc.reflogExpire=never -c gc.reflogExpireUnreachable=never \
  -c gc.autoDetach=false gc --quiet --cruft --prune=never
```

这些参数在已有影子仓库隔离环境中运行：对象不按年龄裁剪，reflog 不过期，不可达对象也保存在 cruft pack 中。`gc.auto=0` 和 `maintenance.auto=false` 仍然有效，因此打包时机由宿主掌握。这里采用普通 gc，不启用成本更高的 `--aggressive`，也不传会绕过维护锁的 `--force`。参数语义见 [Git 2.43 的 gc 文档](https://git-scm.com/docs/git-gc/2.43.0)，小批量导入的解包行为见 [fast-import 配置](https://git-scm.com/docs/git-config/2.43.0#Documentation/git-config.txt-fastimportunpackLimit)。本实现要求 Git 支持 `--cruft`，已在 Git 2.43.0 验证。

维护期间会占用历史队列，并暂时同时保存旧 pack 与新 pack，需要额外磁盘空间。保留全部资产也意味着总大小仍随历史增长；维护减少松散对象和重复内容的成本，不为历史设置总量上限。

## 验证入口

从仓库根目录运行：

```sh
npm run check --workspace=@repa/space-history
npm test --workspace=@repa/space-history
npm run build --workspace=@repa/space-history
npm run benchmark --workspace=@repa/space-history
npm run benchmark:maintenance --workspace=@repa/space-history
npm run benchmark:paths --workspace=@repa/space-history
```

测试使用真实 Git 和临时目录，覆盖普通空间、用户仓库与 linked worktree 的逐字节隔离、搬家、排除规则、shell 修改、来源分离、串行活动、按路径记账与按路径的外部快照、运行树与按运行撤销、局部撤销、冲突、旧格式历史、变更追赶、监听关闭及 Git 子进程错误。维护测试还核对门槛、重开、队列、维护锁及失败重试，确认旧提交、不可达对象和过期 reflog 都保留，原始字节仍可读取和撤销。启动次数测试为打开、快照、按路径记账、不透明运行、撤销、维护和变更追赶设定启动 Git 的次数上限，不断言耗时。

## 对模型的影响

无：本包保存空间文件历史并提供变更查询和撤销接口，不向模型注入提示、工具或上下文。

## 已知限制与暂缓

- 外部编辑器与其他不经过队列的写入者不受 `record` 协调。它们若在 run 中写入，最终快照无法判断谁写了哪些字节；宿主应协调已知写入者，避免同期编辑。`recordPaths` 只在给定路径上有这个问题：回调期间别处的写入不会混入，同一路径上的同期写入仍算作这次写入。快照和多文件恢复也不是文件系统事务，扫描或恢复期间应保持文件稳定。单文件替换是原子的，多文件 I/O 失败可能留下部分恢复；本包会尝试将已发生的恢复记录为 undo 提交，再传播异常。

- 进程突然退出时，尚未提交的文件在下次启动归为外部改动，原 run 的来源无法重建。两个后端进程或两个活动实例共同操作同一历史不在此版范围内。包内队列只序列化这个实例的操作，不提供跨进程锁或沙箱。

- Git 保存文件内容、符号链接和可执行位，不保存空目录、完整权限、所有者、ACL、扩展属性和原修改时间。恢复时保留仍存在文件的读写权限，重新创建的文件采用 `0600`，可执行文件采用 `0700`；未涉及文件的内容和 mtime 保持不变。路径要求有效 UTF-8，非法编码会报错而不是静默遗漏。符号链接目标仍按原始字节保存。

- 快照会读取所有符合范围的文件，`recordPaths` 只读取给定范围；内容随读随写入 `fast-import`，不在内存中积攒。变更查询读取游标后的全部提交，撤销会一次性缓存本次要恢复的 blob。大规模二进制资产及大规模恢复的资源占用仍待按实际工作负载验证。
