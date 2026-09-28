# 空间备份、恢复与独立复制

[SpaceOperations](../../packages/repa/src/spaces/store.ts) 负责空间目录的准备、校验、发布和操作结果恢复。应用协调层确保空间没有正在运行的任务或尚未完成的内容、配置操作，并在快照期间阻止新操作进入该空间；其他空间继续使用。正在运行的 Agent 不会被备份调用取消，调用返回 `space_busy` 后可在任务结束时重新发起。

## 公开接口

| 调用 | 输入 | 结果 |
| --- | --- | --- |
| `space.backup` | `spaceId`、`destination`、`operationId` | 创建包含当前内容、所保留历史和已声明数据的备份目录 |
| `space.restore` | 备份目录 `source`、`destination`、`operationId` | 将备份恢复到新的工作目录，保持空间身份 |
| `space.copy` | `spaceId`、`destination`、`operationId` | 创建拥有新空间身份、可以独立演变的工作目录 |
| `space.operation.get` | `operationId` | 查询 `unknown`、`prepared`、`completed` 或 `failed` |

目标必须是尚不存在的目录，父目录已经存在，并位于源目录之外。调用成功发布后返回实际目标、空间身份、参与数据 owner 的版本与外部依赖；调用方按需要使用 `space.open` 打开。备份目录直接打开会返回 `snapshot_requires_restore`。同一空间身份的两个目录不能在一个后端中作为独立空间同时打开。

```ts
const operationId = crypto.randomUUID();
const result = await client.call("space.copy", {
  spaceId,
  destination: "/path/to/independent-space",
  operationId,
});
if (result.status === "completed") {
  const copy = await client.call("space.open", { path: result.destination });
}
```

长操作超出客户端请求期限时，后端仍会完成已受理工作。保留原 `operationId` 并查询结果；相同输入的重传返回原结果，失败操作也不自动重做。准备前的参数、空间忙碌和目标占用等错误直接返回 RPC 错误；已经写入操作记录后的失败保存在结果的 `error` 中。

## 身份与格式责任

独立空间复制改变 `spaceId`，保留空间内的内容 `id`。完整身份是 `{ spaceId, id }`，因此两份内容互相独立，同时空间相对的 `repa:document/<id>` 链接继续成立。这与空间内 `content.copy` 分配新内容 `id` 的情况不同。

[内容快照适配](../../packages/repa/src/content/snapshot.ts) 映射内容清单、明确成员、资源引用、当前和历史学习语境组成格式，以及对应操作前后版本。历史操作继续支持在副本中查询与撤回。只有格式 owner 能确定的字段才映射，普通代码、任意 JSON 和 Markdown 正文中的历史陈述按原字节保留。

运行日志由原有 `run-journal` 读取并映射请求所属空间。Pi 会话保留原 JSONL 与真实历史文字，使用 Pi 的 `listAll(sessionDirectory)` 从所属空间目录列举，打开时通过 `cwdOverride` 指向新目录。`list(cwd, sessionDirectory)` 会按历史 cwd 过滤，因此不适用于空间搬移与恢复。消息媒体投影为副本的资源引用。复制不会根据对话中的路径文字去读取或改写原空间。

外部材料仍指向原件，并作为 `externalDependencies` 返回；副本不会复制应用侧的模型连接、凭据或外部文件授权。需要自包含时先显式 `material.collect`；重新授权和重定位使用已有内容关联入口。普通文件树中的符号链接原样保存，不跟随链接收进外部字节；相应目标仍依赖其实际文件环境。

未确认的内容恢复状态可随备份保留，以便继续处理；独立复制会返回 `recovery_required`。备份包含保留关系需要的 blob，不携带无引用缓存，也不恢复前端的旧连接租约。

## 插件持久数据的参与点

`ApplicationOptions.snapshotParticipants` 接受 `SpaceSnapshotParticipant`，声明 `id`、数据 `version`、空间内持久目录和 `capture`。目录位于 `.repa/` 下，不能与基座数据或其他参与者重叠。简单工具和提示无需注册参与者。

```ts
const participant: SpaceSnapshotParticipant = {
  id: "review",
  version: "1",
  directory: ".repa/plugins/review",
  async capture({ sourceDirectory, destinationDirectory,
                  sourceSpaceId, targetSpaceId, mode }) {
    // 使用所属数据库的快照接口，将一致数据写入 destinationDirectory。
    // 独立复制时由此能力将业务引用映射到 targetSpaceId。
  },
};
```

参与者负责自己数据的一致性、待完成写入的协调和独立副本中的业务引用。基座复制其产出的文件，记录 owner 和格式版本，并做完整性校验；基座不理解数据库表、算法状态或业务事务。普通文件的外部变化通过复制前后校验发现，任意应用外写入不参与应用内的提交协调。

`.repa/` 中出现未声明 owner 的持久目录时，操作返回 `snapshot_owner_unavailable`，由对应能力补上快照接入。已建立的备份可以原样恢复其不透明数据，结果继续列出参与者和版本；是否支持该数据版本以及迁移方法，在加载所属能力时处理。

这是一处可供 #20 插件宿主调用的生命周期入口，当前没有插件发现、启停或通用数据库 schema。已有内容中的学习语境格式适配也随 #20 迁入官方学习能力。

## 发布与中断恢复

```text
<backup>/
  .repa-snapshot.json        # repa.space-snapshot v1；身份、owner、文件清单与校验值
  .repa-space-operation.json # 发布回执
  data/                     # 普通内容、.repa 持久数据；不含运行锁和活连接租约

<application-directory>/
  space-operations/<id>.json # repa.space-operation v1；输入摘要、源、目标和实际结果
```

空间操作先记录 `prepared`，在目标的同级临时目录中准备全部内容，校验与落盘后通过目录重命名发布。操作记录和目标位置复用 `proper-lockfile` 做独占协调；当前源空间继续由 `RuntimeStore` 持有。已有目标不会作为恢复覆盖对象。

发布目录内的回执使“目录已经发布、应用回执尚未写完”的中断可被确认。重新查询发现匹配的完成回执时补齐结果；尚未发布的准备目录只有在归属标记匹配时才清理，操作标记为 `interrupted`，不自动再执行。复制和恢复后的工作目录保留这份发布回执，后续使用不更新它。

恢复前检查快照格式、文件哈希、路径层级和空间身份。管理目录禁止符号链接，文件不能借清单路径写到目标之外。当前回归证据覆盖 Linux、本地文件、真实 Pi 会话与 SQLite 快照参与者；跨平台文件模式、特殊文件和不同数据库适配需要对应环境验证。
