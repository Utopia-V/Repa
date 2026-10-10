# 空间历史与变更流

`@repa/space-history` 为普通空间目录保存文件历史，也能用于已有 Git 仓库的目录。它只依赖 Node.js、TypeBox 和可配置的系统 Git，不依赖现有后端包。历史位于 `<space>/.repa/history.git`；随整个空间目录一起搬家后，原有 revision 和撤销仍然有效。

## 使用

```ts
import { writeFile } from "node:fs/promises";
import { openHistory } from "@repa/space-history";

const history = await openHistory("/path/to/space", {
  gitPath: "/usr/bin/git", // 默认使用 PATH 中的 git
  maxFileBytes: 10 * 1024 * 1024, // 默认上限为 10 MiB，等于上限仍保留
});

const run = await history.record({ kind: "agent", runId: "run-123" }, async () => {
  await writeFile("/path/to/space/notes.md", "新笔记\n");
  // 这里也可以执行 shell 或插件代码；结束前等待它们完成写入。
});

const undo = await history.undo(run.snapshot.revision);
console.log(undo.restored, undo.conflicts);
```

宿主为每个空间持有一个 `history` 实例，并把从用户消息到回复结束的整个 run 放进 `record`。它先提交已有的外部改动，再执行回调，最后保存本次运行；即使回调抛错，已落盘的修改也会保存后再传播异常。保存失败时，实例会保留尚未提交的来源；后续调用先补完这次保存，再处理排队的外部快照或新活动，原回调不会重跑。宿主应在保存故障期间暂停其他文件写入。每个 `runId` 只接受一次，空运行也有一个提交。独立的插件写入使用 `{ kind: "plugin", pluginId: "learning" }`，同样经过 `record` 排队；运行内部调用的插件则直接完成写入，归属当前 run。

回调持有队列，因此应直接操作空间文件，不在内部等待同一实例的历史方法。宿主应先查询所需历史，再进入 `record`。回调必须等待其子进程和其他写入者结束，不能留下继续写文件的后台任务。

| 接口 | 行为 |
| --- | --- |
| `openHistory(space, options?)` | 打开已有目录，初始化或复用历史，并立即保存外部改动。空空间也建立基线提交。 |
| `snapshot(source?)` | 按需扫描；默认来源为 `external`，也接受 `agent` 或 `plugin`。返回 `revision`、是否新建提交的 `committed` 和跳过项 `skipped`。直接指定来源时，调用方负责先隔离已有改动；通常优先使用 `record`。 |
| `record(source, action)` | 串行执行前置外部快照、活动及末尾快照，返回回调的 `value` 和 `snapshot`。 |
| `list(limit = 100)` | 从新到旧返回 revision 的 ID、父提交、来源和 ISO 时间。 |
| `changesSince(cursor)` | 返回游标之后按时间顺序排列的 revisions，每项带 `changes`，以及本次查询的终点 `revision`。`null` 从基线开始；无效或不属于当前历史的游标报错。 |
| `undo(revision)` | 撤销一个非基线提交，包括先前的 undo；返回新 revision、已恢复路径和冲突路径。全部冲突或目标为空时，也保存一个空的 undo 提交。 |
| `onRevision(listener)` | 提交完成后唤醒订阅者，返回取消订阅函数。订阅者异常作为进程 warning 报告，不改变已成功的提交。 |

agent 空运行和空的 undo 操作也保留提交，其他无变化的快照不产生提交。来源直接保存在提交消息的 JSON 中，例如 `{"kind":"agent","runId":"run-123"}`；撤销使用 `{"kind":"undo","revision":"…"}`。本包导出这些公开数据的 TypeBox schema 和对应类型。

## 插件追赶与外部监听

通知只是唤醒信号。插件启动时就应调用 `changesSince`，之后从自身保存的 cursor 继续追赶；处理并保存插件状态成功后，再将 cursor 推进到返回的 `revision`。插件自行安排重试、幂等处理及状态和 cursor 的一致保存，宿主不替插件维护游标。

每个 revision 的 `changes` 包含 `added`、`modified`、`deleted` 或带 `previousPath` 的 `renamed`。查询保留逐提交变化，因此先新增后删除、修改后又改回原文都不会被净差异抹掉。重命名沿用 Git 的内容相似度判断；未识别出的重命名仍以删除和新增返回。路径相对于空间根目录，使用 `/` 分隔。

`watchHistory(history, watch, { debounceMs?, onError })` 接受宿主提供的监听注册函数：`watch(notify)` 注册后返回停止函数。默认 debounce 为 100 ms，`flush()` 等待已观察到的变更保存，`close()` 停止监听并等待最后一次保存。后台保存错误交给 `onError`；调用方处理故障后，可调用 `history.snapshot()` 重试。

宿主的 watcher 必须排除 `.repa/`、`.git` 等控制目录的事件，避免保存历史反过来触发无限快照。运行期间的快照请求会排在活动之后。即使监听事件丢失，打开历史和下一次 `record` 的前置快照仍会收集当前磁盘上的变化；两次扫描之间出现又消失的临时内容无法恢复。本包提供监听适配器，实际文件监听和后端接入由重建后的宿主负责。

## 保存与撤销的取舍

- Shadow Git 使用自己的 index 和本地 committer 身份。Git 操作显式绑定 shadow 仓库和独立 index，工作树操作另显式指定空间目录；同时隔离继承的 Git 环境、系统和全局配置、全局忽略、hooks 与自动维护。用户的 `.git`、index 和暂存内容不参与操作。
- 候选路径通过 Git 批量枚举，尊重空间内层叠的 `.gitignore`。空间根下的 `.repa/`、任意 `.git`、带 `.git` 标记的嵌套独立仓库和可识别的 bare 仓库整体排除；其中的工作树内容不受本包保护。普通大文件及特殊文件也跳过，`skipped` 给出大小、仓库或特殊类型的原因；忽略项不逐个列出。
- 原始文件字节通过 `fast-import` 流式批量入库，再批量构建 index 和提交，不逐文件启动 Git。这样既保留 CRLF、二进制和符号链接本体，也不执行 clean/smudge filter 或换行转换。实现固定使用 SHA-1 对象格式，索引和提交中的路径均为相对路径。所用批量接口见 Git 的 [fast-import](https://git-scm.com/docs/git-fast-import/2.43.0) 和 [ls-files](https://git-scm.com/docs/git-ls-files/2.43.0) 文档。
- 撤销前先保存外部改动。此后，只要目标路径或相关父子路径被后续提交触碰过，就报告冲突；内容后来改回一样也不例外。恢复前还检查当前内容、忽略规则和路径边界。重命名两端及文件/目录转换成组处理，有冲突的组保持原样，独立路径仍可恢复。
- 恢复只写目标提交的路径。文件与目录互换时，只有待清理目录中的文件全都属于本次可撤销新增内容，才允许恢复，因而额外的忽略文件也不会被删除。常规文件先写同目录临时文件再原子替换，避免写入失败先丢失当前文件。祖先符号链接作为冲突处理，不沿链接向空间外恢复。
- 新的忽略规则、大小上限或嵌套仓库边界可能让旧条目离开历史覆盖范围，变更流因此会报告 `deleted`，但磁盘上的文件未必删除。插件应据此重新读取当前状态；撤销也会检查真实文件，不按历史树中的缺席盲删。

## 当前限制

外部编辑器与其他不经过队列的写入者不受 `record` 协调。它们若在 run 中写入，最终快照无法判断谁写了哪些字节；宿主应协调已知写入者，避免同期编辑。快照和多文件恢复也不是文件系统事务，扫描或恢复期间应保持文件稳定。单文件替换是原子的，多文件 I/O 失败可能留下部分恢复；本包会尝试将已发生的恢复记录为 undo 提交，再传播异常。

进程突然退出时，尚未提交的文件在下次启动归为外部改动，原 run 的来源无法重建。两个后端进程或两个活动实例共同操作同一历史不在此版范围内。包内队列只序列化这个实例的操作，不提供跨进程锁或沙箱。

Git 保存文件内容、符号链接和可执行位，不保存空目录、完整权限、所有者、ACL、扩展属性和原修改时间。恢复时保留仍存在文件的读写权限，重新创建的文件采用 `0600`，可执行文件采用 `0700`；未涉及文件的内容和 mtime 保持不变。路径要求有效 UTF-8，非法编码会报错而不是静默遗漏。符号链接目标仍按原始字节保存。

所有提交都保留，当前没有历史裁剪和自动维护入口。快照会读取所有符合范围的文件；变更查询读取游标后的全部提交，撤销会一次性缓存本次要恢复的 blob。下面的测量针对千文件空间，长期大量提交和大规模恢复的资源占用尚待验证。

## 验证与计时

从仓库根目录运行：

```sh
npm run check --workspace=@repa/space-history
npm test --workspace=@repa/space-history
npm run build --workspace=@repa/space-history
npm run benchmark --workspace=@repa/space-history
```

类型检查、构建及 47 个测试全部通过。测试使用真实 Git 和临时目录，覆盖普通空间、用户仓库与 linked worktree 的逐字节隔离、搬家、排除规则、shell 修改、来源分离、串行活动、局部撤销、冲突、变更追赶、监听关闭及 Git 子进程错误。

计时环境为 Ubuntu 24.04、Linux x64、Node.js 24.20.0、Git 2.43.0，临时目录 `/tmp` 位于 ext 文件系统（类型 `0xef53`）。每个独立样本有 1,000 个各 1,024 bytes、内容含不同编号的小文件，以及 4 个各 12 MiB 的大文件；后者按默认 10 MiB 上限跳过。文件刚准备或改写完成，操作系统缓存保持自然状态，未做冷缓存处理。准备和校验时间不计入测量；撤销包含前后两次快照。

2026-10-10 的三次独立测量如下，单位为 ms：

| 样本 | 初次打开，含初始化和基线 | 无变化快照 | 1,000 个文件全部修改后的快照 | 撤销，含前后快照 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 82.182 | 46.440 | 69.367 | 265.243 |
| 2 | 65.954 | 43.601 | 59.981 | 220.111 |
| 3 | 62.995 | 39.333 | 61.225 | 212.550 |

三个样本均恢复全部 1,000 个小文件，4 个大文件均跳过且字节保持不变；计时程序逐文件校验后清理临时目录。可通过 [test/benchmark.ts](test/benchmark.ts) 复测。
