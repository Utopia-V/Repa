# 内容、保存与恢复

`ContentStore` 是一个学习空间中正文、身份和内容关系的共同修改入口。前端通过应用协议调用，Agent 通过常规 `read`、`edit`、`write`、`apply_patch` 工具调用。两条路径都经过同一个实例和串行队列；模型不填写 `operationId`。

这些接口对应三种不同意图：`edit` 根据当前内容中的明确片段做局部替换；`write` 用所观察版本保护整篇保存；`apply_patch` 让一组已经确定的文件变化共同保存。局部修改无需先读取全文，保存也不会自动启动 Agent。选择这些行为的原因、复用 Pi 的边界和维护代价见 [ADR 0003 的编辑与保存](../adr/0003-share-file-based-content-operations.md#编辑与保存)。

## 目标与版本

普通文件通过 `ContentTarget.kind = "file"` 和空间内路径访问，读取不会自动登记身份。需要持续引用时，`content.associate` 建立 `ContentRef`，区分 `document` 与 `material`。`content.get` 返回解析后的身份、位置和可用状态；移动更新位置，已删除或解除关联的身份不会指向后来占用同一路径的新文件。

| 字段 | 所属对象与用途 |
| --- | --- |
| `ContentInfo.bodyRevision` | 实际文件字节的版本；`content.write.base`、删除正文的 `content.remove.base` 和分页读取的 `revision` 使用它 |
| `ContentInfo.revision` | 已登记内容的身份、位置、状态与组成版本；`content.relink`、`content.setComposition`、`content.move/copy`、`material.collect` 和解除材料关联的 `content.remove.base` 使用它。普通文件的该字段同时反映字节与位置 |
| `ContextState.revision` | 学习语境绑定自身的版本；`context.set.base` 使用它 |
| 内容订阅事件的 `revision` | 当前后端的查询失效标识；不能作为文件保存基准或持久历史版本 |

这些字段是不透明字符串。正文编辑不替换组成关系，修改语境成员正文不要求重写语境绑定。目录列举只返回条目元信息，不读取所有文件正文；条目上的空版本表示尚未取得该对象的修改基准。

整篇写入检查 `bodyRevision`，新增文件使用 `{ kind: "absent" }`。精确 `edit` 在当前内容中定位唯一文本片段；补丁使用 `*** Begin Patch` 格式，支持增加、删除、修改和移动。定位用的宽松空白与标点比较不会改写未涉及的字符或换行。

## 客户端保存示例

```ts
const target = {
  kind: "file" as const,
  spaceId,
  location: { kind: "relative" as const, path: "notes/architecture.md" },
};

const opened = await client.readText(target);
const operationId = crypto.randomUUID();
const result = await client.call("content.write", {
  target: opened.content.target,
  base: opened.content.bodyRevision!,
  value: { kind: "text", text: editedText },
  operationId,
});
```

`content.read` 是可分页的预览。`client.readText` 在预览截断时读取对应不可变资源，取得同一修订的完整 UTF-8 正文；二进制交给相应处理器。编辑器不能将截断片段当作整篇内容保存。

断线或超时后保留 `operationId`，通过 `operation.get` 核对。相同操作的重传返回原结果，修改参数须使用新标识。保存回执只确认本次实际提交的草稿版本；后续本地输入和外部修改由草稿服务继续处理。文件保存不会启动模型。

当前内容方法还包括 `content.list/get/read/edit/applyPatch/associate/relink/remove/setComposition/move/copy`、`material.collect`，以及 `operation.get/undo/reconcile/prune`、`context.get/set/preview`。参数、返回值和运行时校验来自 [内容协议](../../packages/repa/src/content/protocol.ts)。文本／历史检索及本地材料表示见[搜索与材料](search-materials.md)。

## 同次保存正文与结构

拆出一份新文档时，除了写文件，还可能需要为它建立身份，修改正文引用和组成关系。`content.applyPatch` 可以把这些变化放在同一项操作中保存。

`registrations` 为已有文件、本次补丁的新文件或目录登记身份，也可提供初始 `members/resources`。显式给出的 `id` 能被同一补丁引用，省略时由保存入口生成。所有新身份建立后，再解释初始组成。修改已有对象的组成，则通过 `compositions` 提交 `{ ref, base, members, resources }`。

正文、新身份和结构修改仍进入同一个 `ContentStore` 计划，再由一次 `FileJournal.commit` 保存。登记核对的是计划完成后的文件，不要求新文件先单独落盘；现有组成基准对操作前的结构核对，同一补丁移动对象不会造成自身版本冲突。原 patch-only 请求及旧 RPC 透传的 `spaceId` 保留原去重形状，可选字段不补默认空列表。

正文中的链接和学习语境 JSON 清单都通过文本补丁修改。哪些引用应当指向拆出的文档，需要调用方先根据含义确认；学习清单的 `items` 也由学习能力解释，与普通组成的 `members` 分开处理。完整场景见[内容整理](organization.md)。

Agent 的 `apply_patch` 使用相同选项，操作标识由适配层生成。`content_info` 查询身份、结构修订和组成，`content_operation` 提供操作查询与撤回。模型需要根据保存结果继续工作，因此成功回执和保存错误的文本中都提供 `operationId`，而不只放在日志与界面的 `details` 中。这些工具使用当前空间的范围。

## 移动、复制与收集

`content.move` 保持已有内容身份，`content.copy` 为实际复制的已登记内容分配新身份。操作接受 `target`、结构版本 `base`、相对 `destination` 和 `operationId`。它们递归处理目录和明确的组成成员，并在同一次内容提交中保存文件与引用关系；普通链接不增加复制范围。未登记的普通文件仍可保持为普通文件。

默认从源目录或源文件父目录保留成员的相对布局，源对象放到指定目标。组成成员跨越这些目录时使用 `container: true`，以共同父目录保留完整布局。例如 `notes/a.md` 与 `code/b.py` 组成的产物，复制到 `copies/run1` 后分别位于 `copies/run1/notes/a.md` 和 `copies/run1/code/b.py`。目标已存在、布局重叠或结构版本改变时返回冲突。

独立内容复制使用 micromark 4.0.2 的 CommonMark 位置 token，仅重写实际链接目标中的规范 `repa:document/<id>`、`repa:material/<id>`，保留定位后缀、代码示例、其他文字和原换行。明确的组成成员引用与已知学习语境 JSON 引用同时映射；其他格式按原字节保存，格式专用引用交给对应能力。移动保持身份引用，普通路径链接继续按原路径语义解释。

外部成员继续作为依赖。`material.collect` 将已关联外部材料的实际字节保存到空间内，保持身份，并在 `ContentInfo.origin` 中保留原位置；原件继续保留。关联和重关联本身只读取元信息，返回值不一定包含 `bodyRevision`，需要正文版本时再调用 `content.read`。

当前内容树移动与复制遇到符号链接会明确拒绝；整个空间的备份和复制可以原样保留符号链接，见[空间快照](spaces.md)。

## 持久数据与可见结果

```text
<space>/
  普通内容文件……
  .repa/
    content/
      catalog.json          # 身份、位置、组成与语境绑定
      operations/<id>.json  # 内容操作的准备、结果与恢复状态
      retired-operations.json # 已清理操作的紧凑回执
      resources.json        # 消费者保留关系与临时持有
      blobs/<sha256>        # 不可变字节，含操作前后版本及上传资源
    runtime/                # 空间身份、锁和运行记录
    sessions/               # Pi 会话 JSONL
    settings.json           # 空间与会话提示覆盖
```

空间运行锁由 `RuntimeStore` 持有。`ContentStore` 准备具体文件效果，`FileJournal` 先持久保存恢复记录，再写入文件，全部完成后记录 `committed`。正文与相关清单可以属于同一次操作。客户端在完整操作后取得结果批次；原生文件系统访问者仍可能看到中间状态。

操作记录区分 `prepared`、`committed`、`rolled_back`、`needs_recovery` 和 `reconciled`。重开空间时检查未完成操作的真实文件，只在当前内容仍能确认为本操作效果时恢复；不能确认的后续修改保留为冲突。相关结构访问返回 `recovery_required`，按实际文件路径读取和修复仍可进行。

`operation.reconcile` 检查修复后的结果。中断移动涉及身份位置时，需要先通过 `content.relink` 等实际操作修复，再解除状态；原中断记录保留。撤回通过新的 `undoOperationId` 执行，能够分离的后续文本和关系变化继续保留。重复文本、重叠改动或位置重新被占用时返回冲突；当前文本合并依据唯一未变行保守定位，不能保证自动合并所有字符级编辑。撤回会移除本操作创建且仍为空的目录，保留后来加入的文件与独立目录变化。

操作前后字节随完整历史保留；历史清理、会话删除与临时实例释放后，由 `resource.collect` 按实际保留关系回收资源。当前文件、其他消费者以及有效的旧版本持有继续成立，详见[资源持有与清理](resources.md)。

## 外部材料与资源

经过认证的前端调用 `content.associate` 或 `content.relink`，明确选择空间外文件时，应用在 `repa-content-access.json` 中保存该空间对实际规范文件路径的只读授权。授权位于应用配置目录，空间内的内容清单不能自行授予权限。普通模型读写工具不会建立该授权；已启用 Skill 的自有目录只向读取适配器开放。

默认关联原件，内容中保存外部位置。`content.remove` 配合 `detach: true` 解除材料身份关联并保留原件；这一步不等于收回应用已有的文件读取授权。空间外写入当前返回 `permission_required`。

`client.uploadResource(spaceId, bytes, mediaType)` 上传不可变字节，返回 `{ id, resource, expiresAt }`，当前单次上限为 64 MiB。内容读取得到的 `ResourceRef` 可通过 `client.resource(ref)` 获取，并支持单个 HTTP 字节范围。资源按已打开空间读取；标识本身不构成授权。当前接口供已认证的前端使用，可执行展示实例的受限资源桥接仍待实现。

学习语境的绑定、组成格式和展开由 [`LearningContext`](learning.md) 负责。它通过 `ContentStore.observe` 在同一次队列操作中读取成员，通过 `setMetadata` 保存绑定。版本检查、去重、journal、撤回和恢复都使用已有内容操作；`ContentStore` 不再直接提供学习语境方法。

`ContentFormat` 说明所属 catalog 字段和引用怎样复制。学习格式沿用 v1 catalog 的 `context` 字段，独立于学习运行服务安装。因此，关闭学习能力后，普通保存和空间复制仍能处理原有绑定及历史组成；复制后的撤回也使用副本内引用。格式接入与旧数据处理见[学习语境说明](learning.md#保存历史与复制)。
