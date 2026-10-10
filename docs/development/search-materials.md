# 搜索与材料读取

当前可以搜索空间文本、指定会话的历史和 Wikipedia 百科条目，读取命中附近的内容，也可以通过材料包提取本地文件、固定资源或获取明确 URL 的原件。Agent 工具与公开客户端使用同一份后端实现，图形界面尚待接入。

## 设计思路

拿到一条搜索结果后，你还会想知道它出自哪里、当时读的是哪个版本，以及上下文说了什么。因此，搜索结果除了片段，还保存来源、修订和定位。你可以读取当时保留的原件，也可以带着修订读取活动内容，核对它是否已经变化。Agent 使用的是同一份结果。

文件搜索复用 ripgrep，会话搜索复用 Pi 已经解释好的历史。这里补充了关于内容授权、字节快照和结果保存的处理。当你继续翻页，读到的仍是这次查询的结果，期间新增的消息或文件修改不会混进后续页。

你提供的材料也可能是 PDF、网页或图片，需要先取得适合阅读的表示。如果从网上找到材料，可以先看 Wikipedia 返回的条目和片段，再选择明确的 URL 获取完整原件；片段只是发现线索，不是已经读过的正文。材料包复用同一组读取器处理本地和在线原件，并把在线获取时的请求地址、最终地址和实际字节一起交付。保存原件及其来源后，后续阅读可以核对当时取得的版本，而不必假设网页仍保持原样。你写下的校订、批注和整理稿则作为长期文档保存，后续修改有自己的基准。

当前查询按需进行并设有范围限制，尚不维护索引数据库。这样可以直接以本次取得的内容为依据，省去索引与外部编辑、授权变化之间的同步。是否需要索引，应由实际查询规模与时延决定。

## 公共调用与纯协议入口

官方搜索插件 `repa-search` 提供四个空间范围契约。公开客户端通过 `capability.invoke` 调用，Agent 工具使用同一处理函数：

| 契约版本 | 工具 | 行为 |
| --- | --- | --- |
| `repa.search.content/1` | `grep` | 搜索空间文本和明确关联的外部材料 |
| `repa.search.history/1` | `search_history` | 搜索指定 `sessionId` 的冻结历史 |
| `repa.search.page/1` | `search_page` | 从已保存的查询结果读取后续页 |
| `repa.history.read/1` | `read_history` | 根据历史修订和消息位置读取邻近交流 |

搜索使用后台能力，结果分页和历史局部读取使用 inline 能力。客户端搜索由 `BackgroundRequests` 受理，可以查询或取消；客户端离开后，后端按请求规则处理。Agent 工具等待搜索结果，使用父运行的取消信号和资源归属。共同规则见[请求说明](requests.md)与[能力宿主](capabilities.md)。

浏览器可用的 schema 位于 [search/protocol.ts](../../packages/repa/src/search/protocol.ts)，由 `repa/protocol` 导出。查询、匹配、游标和页面都可以从这里取得类型，无需导入搜索执行器或 Node 代码。

公开能力的后台结果会在外层记录能力契约。取出其中的 `Representation` 后，按 `repa.search-results/1` 检查 `value.data`，再根据 `kind` 区分内容或历史结果。页面包含 `matches`、`total` 和可选的 `next`；`next.snapshotIndex` 指向标准 `resources`，调用下一页时取该资源的 `id` 作为游标的 `snapshot`。

## 内容搜索固定实际字节，而不提前保存全目录

[content.ts](../../packages/repa/src/search/content.ts) 先由内容入口确认目标，再用 `rg -l -0` 找出可能命中的文件。只有这些文件需要取得资源快照并再次匹配，因此一次没有命中的查询不会保存全目录的正文。

预筛结束后，文件可能发生变化。资源服务会在内容队列内取得一份原件字节，记录修订并保留资源，然后退出队列。搜索匹配这份快照，返回的片段、定位和修订也都来自它。文件若已经改到不再匹配，本次就不会返回旧命中；取得快照后，其他内容保存可以进行。

匹配使用 [ripgrep.ts](../../packages/repa/src/search/ripgrep.ts)，包括 literal、ignoreCase、原生 `--crlf` 和 `--encoding=none`。每项内容命中包含：

| 字段 | 含义 |
| --- | --- |
| `sourceIndex`、`resourceIndex` | 指向标准 `Representation.sources` 和 `resources`，来源修订为实际 `bodyRevision` |
| `line` | 从 1 开始的逻辑行号 |
| `byteRange` | 相对于完整原件的字节范围，从 0 开始，不含末端 |
| `range` | 相对于完整解码正文的 UTF-16 范围，从 0 开始，不含末端 |
| `snippet` | 最多 500 个 UTF-16 单元的片段，附原文范围和截断状态，不包含行尾，也不拆开代理项对 |

跳转到活动原文时，使用 `content.read` 并带上命中的 revision。原文已经修改会返回修订冲突，此时仍可以读取搜索结果保留的旧资源。这里的修订对应实际正文，而不是材料身份或组成关系的状态。

### 搜索范围与预算

默认根查询也包含 `ContentStore.list` 中明确关联的外部材料，逐个读取原件，不扫描其父目录。`glob` 只过滤空间目录候选；显式文件查询按所选目标读取。空间外目录不递归搜索，外部文件需要先通过内容授权。

目录扫描排除 `.repa`、`.git` 和提交临时文件，用户 glob 不会取消这些过滤。其中 `.git` 是目录搜索的过滤规则；显式文件查询仍按内容入口判断权限，管理状态的访问保护由 `ContentStore` 负责。PDF 和非 SVG 图片没有可供这条路径定位的文本正文，会返回不可用状态，需要先通过材料能力提取。

一次内容查询最多处理 500 个候选，单文件快照最多 8 MiB，累计快照读取最多 32 MiB。读取前先检查文件大小，读取后再核对实际字节数。达到预算时，结果标记 `truncated`，并在 `unavailable` 中说明受影响目标；原件缺失、无权访问等情况也分别记录。

预算约束快照读取，ripgrep 预筛仍按原生方式扫描目录，因此这不是操作系统级的峰值内存限制。匹配始终使用完整读取的正文，超预算文件不会被截断后拿来匹配。

ripgrep 当前由搜索模块直接启动，没有经过命令执行服务的沙箱。搜索目标由内容接口约束，目录遍历不跟随符号链接，最终结果再通过授权快照取得。这些是应用层的查询范围控制，与[命令沙箱](execution.md)的进程隔离不同。

## 历史查询固定 Pi 分支位置

历史搜索读取会话服务提供的 `Message[]`，搜索其中的 text/thinking 块。Pi JSONL 包含树条目和消息封装，直接 grep 会混入其他分支，并把位置指向存储结构。现有 Pi 适配器已经能够重建目标分支，搜索使用它的结果。

[pi-sessions.ts](../../packages/repa/src/pi-sessions.ts) 用 `history-v1:<sessionId>:<leaf>` 表示历史修订。Pi 条目追加后保持不变，因此固定 leaf 就能重建同一分支；空历史使用 empty anchor。位置不属于目标会话或已无法读取时，返回 `revision_unavailable`。

同一存储会话按 entry 身份复用消息投影。初次打开时建立历史资源的保留关系，之后只处理新增条目，避免每次文本查询都重新解码历史图片。查询返回独立副本，分支另有自己的资源保留关系。升级 Pi 时，需要核对 entry 不可变、`getBranch(anchor)` 和分支资源处理是否保持一致。

[history.ts](../../packages/repa/src/search/history.ts) 将文本块交给同一个 ripgrep 匹配器，再映射回 `messageId`、`blockIndex`、逻辑行和 UTF-16 范围。命中必须位于一个原始块内，不能跨块拼接。当前总正文预算为 8 MiB，达到预算时在完整块之间停止。

取得命中后，可以用 `read_history` 或 `session.history`，带上查询 revision，并把 `messageId` 作为 `around` 读取邻近交流。`before` 用于向前翻页，与 `around` 互斥。历史后来增加消息，不影响已固定位置的读取；查询也不会启动或改变 Agent 运行。

## 分页读取结果，而不再次搜索

[results.ts](../../packages/repa/src/search/results.ts) 将完整结果保存为 `application/vnd.repa.search+json` 的不可变 blob，再返回首页。游标包含所属空间中的 blob 标识和匹配数组的 `offset`，后续页面读取同一个 blob，不再次执行搜索。

每次查询最多保存 1000 项匹配，一页默认 50 项，公开 `limit` 范围为 1—100。`total` 是这份快照实际保存的匹配数，`truncated` 表示预算或上限阻止了完整搜索。分页只切分 `matches`，保留整次查询的不可用目标及资源说明。

页面中的命中和后续游标使用索引，具体空间和来源放在标准 `Representation` 的引用中。复制空间时，共同模块映射这些标准引用，包括能力结果内嵌的表示。搜索 blob 本身保持原字节和 hash，其中保存 `originSpaceId`；搜索模块读取副本中的 blob 时，把属于原空间的引用解释为当前空间的引用。

因此，复制后的首页、后续页和历史定位可以接续使用，旧请求也可以查询原结果，不必为复制重建整份搜索数据。其他业务格式的内部字段仍由各自模块解释。

结果快照和命中的原件通过标准资源声明交给请求或会话保留。查询过程中用到但没有交付的中间资源，按原后台请求的终态规则处理。资源规则见[能力资源说明](capabilities.md#资源声明与结果表示)。

## 材料包与长期文档

[材料包](../../packages/materials/README.md) `@repa/materials` 提供 `repa.material.extract/1`、`repa.material.fetch/1`、`repa.material.search/1`，分别对应 `read_material`、`fetch_material`、`search_wikipedia`。本地提取支持文本、Markdown、代码、已保存 HTML、PDF 文本层，以及图片头信息和原图资源。获取在线原件后也交给这些读取器；三项能力都不需要模型连接。

本地提取先取得原件快照和 `bodyRevision`，随后记录行号、PDF 页码或 HTML 标题与引文定位。HTML 使用 jsdom 和 Readability 处理已取得的原件字节，不执行其中的脚本或加载子资源。图片处理返回尺寸等头信息和原图，扫描 PDF 没有文本层时返回 `empty`。

再次使用原件时，也可以把同一空间的 `ResourceRef` 交给 `target: { kind: "resource", resource }`。材料能力直接读取固定字节，不先创建文件或重新抓取网页；结果的 `resources[0]` 保留原件，`sources` 为空，段定位仍在提取数据中。可选 `expectedBodyRevision` 只核对该资源 ID。文本与 HTML 的可选 `encoding` 优先于媒体类型中明确的 `charset`，均未提供时按 UTF-8；实际解码器记录在 `reader.encoding`，调用方可以据此续读先前取得的非 UTF-8 网页。调用示例见[固定原件提取](../../packages/materials/README.md#再次提取固定原件)。

PDF 使用系统 Poppler。`pdfinfo`、`pdftotext` 的命令名或路径只能在 application 配置中设置，空间文件不能覆盖。一次 `pdftotext` 调用读取所选页范围，再按换页符区分页码，避免每页都重新启动程序解析整份 PDF。

命令输出最多 4 MiB，超过时需要缩小页范围；返回正文另有字符和段数预算。已知大于 32 MiB 的原件在读取前返回 `limit_exceeded`，`reader.name` 为 `"none"`。文件未形成快照，来源与资源为空；资源目标保留已有引用，但本次尚未完成字节校验或提取。

Poppler 当前由材料包直接启动，没有接入命令服务的清洁环境、沙箱或进程组管理。取消会等待解析 worker 或直接子进程退出。这些执行条件与外部依赖见[材料包说明](../../packages/materials/README.md)。

重新提取会产生新的表示，人工校订、批注和整理稿使用内容工具保存为独立文档，原有修改不被提取过程覆盖。原件移走后，只要请求、会话或长期内容还持有相应资源，就可以读取保留的字节；持有关系释放后按[资源规则](resources.md)回收。修订标识本身不保存历史原件。

### 在线发现与获取

如果还没有材料地址，可以用 `search_wikipedia` 查询指定语言版 Wikipedia。`repa.material.search/1` 固定调用该语言版的官方 MediaWiki Search API，不查询其他网站，也不需要新凭据。默认语言是 `zh`，`limit` 默认 10、上限 50；`offset` 从 0 开始，结果给出 `total` 和可用于下一页的 `next`。每项结果包含标题、去掉搜索标记的片段、`pageId`、基于该身份的 `curid` URL，以及可选的 `pageUpdatedAt`。`provider.scope` 为 `encyclopedia`，说明结果仅来自百科索引。片段适合选条目，判断正文时再用 `fetch_material` 获取页面原件。

已经有明确地址时，`repa.material.fetch/1` 用 Node 原生 `fetch` 对 HTTP(S) URL 发起 GET，不跟随网页中的链接、运行脚本或抓取子资源。单次原件上限 32 MiB，网络与提取共用父取消信号，网络获取超时为 30 秒；超限或 HTTP 非成功响应不会把不完整响应保存为原件。成功取得的原字节作为标准 `resources` 返回，同时记录请求地址、重定向后最终地址、获取时间、HTTP 状态、媒体类型，以及响应提供的 `Content-Type`、`ETag`、`Last-Modified`。`source.bodyRevision` 标识所保存的原字节，`origin` 给出 `{ kind: "url", url: finalUrl, retrievedAt: fetchedAt }`。这些字段说明本次实际取得了什么；登记后的文件位置与身份由内容模块持有。

获取后使用本地文本、HTML、PDF、图片读取器生成 `extraction`。显式 `charset` 由 `TextDecoder` 处理；未声明时按 UTF-8，不增加猜测编码的步骤。HTML 仍由 Readability 从已保存字节提取正文，PDF 仍依赖系统 Poppler。没有可用读取器、原件无正文或解析失败时，结果中的状态会说明原因，已取得的原件资源仍可供核对。若要长期放入空间，先用内容接口保存原字节，再在 `content.associate` 或 `content.applyPatch.registrations` 写入返回的 `origin`；可以重新读取这个已登记内容，或通过资源目标选择原获取版本。请求或会话仍持有资源时，可以读取当时的旧原件；长期保存、复制或收集时，由相应内容接手资源关系。来源登记规则见[内容说明](content.md#来源与在线原件)。

Node `fetch` 由可信后台插件直接调用，`execution.run` 对命令的网络策略不会自动约束它。网络能力沿用包的启用与信任边界；使用第三方后台包前仍需判断其宿主权限，见[插件信任说明](plugins.md#信任的实际范围)。

## 未完成项与待验证项

| 项目 | 当前状态与影响 | 后续工作 |
| --- | --- | --- |
| 搜索与材料界面 | 公开接口可用，结果列表、位置跳转、历史查询和材料处理状态尚未接入官方界面 | 由 [#10](https://github.com/Utopia-V/repa/issues/10) 联调，按 [#25](https://github.com/Utopia-V/repa/issues/25) 验证连续使用 |
| 可选格式扩展 | OCR、视觉提取和音视频尚未接入；图片只提供头信息与原图，扫描 PDF 可能没有正文 | 根据实际材料需求选择扩展。音视频属于 #22 的可选内容，不作为现有文本流程的阻塞项 |
| 实际模型使用效果 | 已验证材料、工具、来源和保存的连续路径，模型自主寻找依据和学习质量尚待试用 | 取得模型调用授权后，使用真实任务验证 |

## 验证入口与固定版本

现有 Linux 验证使用 Pi SDK `0.87.1`、ripgrep `14.1.0`、Poppler `24.02.0`、jsdom `30.0.1`、Readability `0.6.0`、image-size `2.0.4` 和 Node `24.19.0`。在线获取复用 Node 原生 `fetch`。

在仓库根目录执行：

```sh
npm run build:backend
npm run check --workspace=repa
npm --workspace=repa exec -- node --import tsx --import ./test/environment.ts --test test/ripgrep.test.ts test/content-search.test.ts test/history-search.test.ts test/search-api.test.ts
npm run test --workspace=@repa/materials
```

搜索测试使用实际 ripgrep，验证定位、候选变更、外部材料授权、管理目录、多空间、预算、冻结历史、分页和 Agent 工具。材料包的 15 项测试通过，覆盖本地文本、代码、HTML、PDF、PNG，以及在线获取、Wikipedia 搜索、取消、人工稿保留和配置作用域。另有真实 Wikipedia 搜索与页面获取验证了网络请求和 Readability 提取。材料授权使用共同资源快照接口；包内测试与内容、资源模块的范围检查共同构成验证依据。

[learning-flow.test.ts](../../packages/materials/test/learning-flow.test.ts) 使用保留原文与出处的 NOAA 潮汐材料，经过关联、提取、定位、提问、搜索、保存笔记、人工校订、关闭重开和再次查询。它使用 Repa、Pi 和本地预设 provider，检查工具声明、输入、来源和持久结果。

主包和材料包还曾以本地 tgz 在临时目录安装，验证离开源码工作区后的入口。主包当前为 private，这项检查针对本地分发包，不表示已经发布到公共 registry。
