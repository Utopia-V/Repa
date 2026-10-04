# 资源持有与清理

不可变字节由空间的 `BlobStore` 保存，资源引用统一为 `{ spaceId, id, mediaType }`，其中 `id` 是 SHA-256。Pi 消息中的图片也转换成这种引用，写入字节和会话持有关系后才发布给前端。HTTP `/spaces/<spaceId>/resources/<id>` 提供认证读取及单个字节范围；响应使用下载形式的 `application/octet-stream`，具体展示方式使用引用中的 `mediaType`。

## 各自持有实际使用的资源

[ResourceRetention](../../packages/repa/src/content/resources.ts) 记录持久消费者与临时使用关系，`ContentStore` 在内容提交队列内提供文件版本和保留范围。

| 消费者 | 保留方式 | 释放时机 |
| --- | --- | --- |
| Pi 会话、分支 | `session:<sessionId>`；投影整个会话树，包含非当前分支的媒体和标准工具结果资源 | `session.remove` 先关闭运行实例，再删除对应 JSONL 并释放会话持有 |
| 会话请求 | `request:<requestId>`；持久输入及本次执行仍在使用的临时工具资源 | 工具结果保存到历史后转交会话，请求继续持有原输入 |
| 独立后台请求 | `processing:<requestId>`；受理输入及实际处理结果 | 请求记录持有最终交付，当前尚无请求清理接口 |
| 文档、组成内容 | 内容清单中的 `resources`；通过 `content.setComposition` 与成员关系一起保存 | 相应内容关系被修改或删除；仍保留的历史可能继续需要旧资源 |
| 内容操作历史 | 操作前后字节，以及历史清单中的资源关系 | 显式清理该操作的完整历史 |
| 前端展示实例 | `resource.hold` 返回固定内容快照和资源列表 | 显式释放、确认关闭宿主，或失联后的租约到期 |
| 上传和预览 | 带有效期的 preparation，避免返回引用后立刻被清理 | 默认十分钟到期，或者确认关闭宿主 |

保存文档、建立分支和打开实例都建立各自的持有。它们可以共用相同字节，释放其中一个消费者不改变其他消费者的使用关系。

后端模块通过 `retention.retain(owner, refs)` 更新所需的完整资源集合，或用 `pinBytes` 保存字节并追加持有；结束使用时调用 `releaseOwner`。`owner` 由所属服务提供，前端按具体操作取得资源，不直接填写这个标识。

建立持有关系时检查空间归属和字节文件是否存在，读取时再核对内容 ID。这样，同一资源被多个消费者使用时，不必为每次保留重复读取整份文件。SDK 的完整输出日志通过 `BlobStore.importFile` 流式导入，也避免了大日志的多份内存副本。

结构化请求在受理时接续输入资源的持有。会话工具结果通过标准 Representation 转交历史，结束后请求仅保留原输入；独立后台处理继续由自身记录保留实际结果。客户端关闭不结束这些持有，详见[请求生命周期](requests.md#持久格式与资源)。插件的数据实体、业务引用与迁移仍由插件拥有。

## 前端调用

打开一个依赖当前文档的实例时，一次调用完成版本解析和持有：

```ts
const instanceId = crypto.randomUUID();
const held = await client.call("resource.hold", {
  spaceId,
  id: instanceId,
  targets: [documentTarget],
});

const input = held.contents.find(item => item.resource);
const bytes = input && await (await client.resource(input.resource!)).arrayBuffer();

// 关闭这个展示实例时释放；已经保存的文档仍有自己的资源关系。
await client.call("resource.release", { spaceId, id: instanceId });
```

`held.contents` 保存请求目标、解析后的 `ContentInfo` 和实际正文资源。目录和明确的组成成员递归取得快照，循环组成去重；不会因 Markdown 普通链接而展开其他内容。外部材料保留位置元信息，需要某次读取的字节时先 `content.read`，再将返回的资源加入 `resource.hold.resources`。

不同实例使用不同 `id`，可以同时打开同一文档的不同版本。同一个 `id` 和相同输入重传时返回最初取得的版本；输入不同返回 `request_conflict`。刷新内容应建立新持有，在切换完成后释放旧持有。已结束的使用不能以原标识重绑最新内容，返回 `lease_expired`；引用字节不可用时返回 `revision_unavailable`。

`client.uploadResource` 返回 `{ id, resource, expiresAt }`。`content.read` 同样返回 `preparation`。准备期内可将资源保存为文件、写入文档组成或转为实例持有；长期使用应由实际消费者接手。`client.readText` 利用这个准备期读取同一修订的完整正文，避免将截断预览当成整篇文件。

## 宿主、重连与退出

`initialize` 返回不透明的 `hostKey`。客户端自动在同一实例的重连中复用；需要恢复该前端的旧实例时，将安全保存的键作为 `ClientOptions.hostKey` 传入。后端以键的摘要绑定真实连接和租约，其他连接不能猜一个实例标识就操作它。上传也携带此宿主键及主连接认证。

`hostKey` 与后端主令牌只交给完整前端宿主。生成页面使用已有的[受限展示桥接](display.md)，只取得绑定资源与动作，页面不直接取得完整客户端。官方展示宿主的装载、隔离与生命周期接入由 [#23](https://github.com/Utopia-V/repa/issues/23) 接续。

活跃宿主的 hold 不因普通租约计时而回收，服务器心跳会刷新落盘期限。短暂断线经过连接宽限期后停止自动续期，默认租约为一小时；`resource.hold.get` 查询原快照，`resource.hold.renew` 在原字节仍可确认时延长使用，绝不改读最新版本。`client.close()` 明确关闭该宿主并释放其使用关系；正在准备的旧操作也不能在关闭后重新建立持有。后端重启以已保存的租约和原宿主键恢复。异常结束后已无法确认的旧输入会明确失败。

`ApplicationOptions.resources` 可调整准备期、持有期限和时钟，默认值属于当前运行策略。显示实例自己的生命周期由前端掌握，不以停止某项订阅代替关闭实例。

## 磁盘格式与回收

`.repa/content/resources.json` 使用版本 `1`，记录持久 `owners` 与临时 `leases`。租约包含宿主摘要、输入摘要、固定内容快照和期限；结束的 hold 保留小型结束记录，避免失联重传改变输入。空间备份保留持久 owner 和必要字节，清除连接租约；恢复备份后的前端重新取得持有。

`operation.prune({ spaceId, operationIds })` 清理所选操作的完整撤回数据，未恢复的操作不能清理。`.repa/content/retired-operations.json` 保留操作标识及输入摘要；`operation.get` 对它返回 `pruned`，旧提交重传返回 `history_pruned`，不会再次执行。清理历史不修改当前文件、身份或组成。

`resource.collect({ spaceId })` 在内容队列中汇总当前文档、剩余历史、持久 owner、有效 preparation 与 hold，删除没有任何保留关系的 blob，并返回删除数量和字节数。资源回收当前由显式调用触发，不按文件年龄自动清理。当前文件正文始终留在普通文件中，缓存字节可在后续读取时重建；被持有的旧版本则必须保留原字节。

Pi 会话 JSONL 仍由 Pi 拥有，Repa 没有另造会话历史格式。打开空间时根据实际会话恢复媒体持有；遇到无法解释的会话文件时保守保留，避免将恢复需要的数据误判为孤儿。
