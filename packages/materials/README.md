# 本地材料读取能力

`@repa/materials` 提供 `repa.material.extract/1`，从本地原件中取得文本行、HTML 正文、PDF 页文本或图片信息，并保留来源和原件资源。它是 Repa 后台能力，处理本地材料无需模型连接或 Agent 会话。

## 安装与接入

包入口为 `repa.backend.entry: ./dist/index.js`，API 范围为 `^1.0.0`，使用公开的 `repa/plugin` 类型与 `repa/protocol` schema，peer 依赖为 `repa@^0.1.0`。主 Repa 包当前仍为 private，本地安装需要提供这个宿主依赖。

在仓库根目录构建和检查：

```sh
npm run build:backend
npm run check --workspace=@repa/materials
npm run test --workspace=@repa/materials
npm pack --workspace=@repa/materials
```

分发包包含 `dist` 和本说明，Node 依赖按包清单安装，PDF 所需的 Poppler 另见下文。官方默认以 `repa-materials` 加载本包，无需用户先安装。

如果要替换成单独安装的版本，先关闭默认项，通过包管理接口安装并按结果重启后端，再使用目录中返回的完整来源配置信任和后台。例如，以下是 `plugins` 命名空间内三项设置的值：

```json
{
  "disabled": ["repa-materials"],
  "backends": [{ "id": "materials", "package": { "kind": "source", "source": "/absolute/path/to/materials", "scope": "user" } }],
  "trusted": [{ "kind": "source", "source": "/absolute/path/to/materials", "scope": "user" }]
}
```

这里不是新的配置文件格式，各项仍通过已有设置接口保存。安装包、信任包和启用后台分别处理，详见[插件说明](../../docs/development/plugins.md)。

## 调用与结果

以下示例读取通过 `content.associate` 登记的来源材料。关联和提取是两项操作，提取失败会保留材料关联，原件和人工校订稿也保持原样。

以下参数交给 `capability.invoke`：

```json
{
  "scope": { "kind": "space", "spaceId": "space-id" },
  "requestId": "unique-request-id",
  "contract": { "id": "repa.material.extract", "version": "1" },
  "input": {
    "target": { "kind": "content", "ref": { "spaceId": "space-id", "id": "material-id" } },
    "expectedBodyRevision": "observed-body-revision",
    "range": { "kind": "pages", "start": 2, "end": 3 },
    "limit": 100
  }
}
```

客户端通过 `request.get` 查询后台结果，通过 `request.cancel` 取消。Agent 使用 `read_material`，等待同一处理函数返回，取消和资源归属使用父运行。

`expectedBodyRevision` 可省略，填写时由内容入口检查实际正文修订。`range.kind` 的 `lines` 用于文本，`pages` 用于 PDF，起止位置都从 1 开始，省略终点表示到实际末尾。

结果采用 `repa.material-extraction/1` 的 `Representation`。其中保存状态、材料类型、读取器及版本、提取段落、总行数或页数、图片元信息和问题说明。标准来源记录内容身份与 `bodyRevision`，每段通过 locator 表示行号、PDF 页码或 HTML 文本位置；原件以不可变资源保留。

公开后台请求还会在外层记录能力契约，读取时先取得其中的原始表示。各状态的含义是：

| 状态 | 含义 |
| --- | --- |
| `ready` | 得到可用表示 |
| `empty` | 读取成功，但没有可返回的正文，例如无文本层 PDF |
| `unsupported` | 当前没有适用的读取器 |
| `invalid` | 所选读取器无法解析原件 |
| `dependency_missing` | 缺少所需外部工具 |
| `limit_exceeded` | 原件或处理输出超过预算 |

目标不存在、授权失败和修订冲突使用内容接口的错误，并保存在请求记录中。原件以后移走时，只要请求或其他内容还持有资源，就能读取当时保存的字节。

### 范围与限额

`limit` 控制返回段数，默认 100，最大 2000；正文最多 200000 字符，达到限制时标记 `truncated`，原件资源保留已读取的完整字节。

原件最多读取 32 MiB。已知超限时不读取正文，状态为 `limit_exceeded`，`reader` 为 `{ "name": "none" }`，来源与资源为空。PDF 一次解析选定页范围，再按换页符建立页码；命令输出上限为 4 MiB，超过时需要缩小页范围。

## 格式与运行条件

- **文本、Markdown 和代码：** 按 UTF-8 原文读取，保留换行和行号。
- **HTML：** 使用 `jsdom@30.0.1` 与 `@mozilla/readability@0.6.0` 处理已保存文件，不执行页面脚本或加载子资源。标题和 quote 用于快照文本定位，`block` 是提取结果中的块序，不是 HTML 字符偏移。
- **图片：** 使用 `image-size@2.0.4` 读取格式、尺寸和已有 EXIF 方向，并返回原图。该过程读取头信息，不解码全部像素，也不进行 OCR 或视觉识别。
- **PDF：** 使用系统 `pdfinfo` 和 `pdftotext`，返回文本层和实际页序。实际页序可能与印刷页码不同；没有文本层时返回 `empty`。

PDF 命令在 `repa.materials` 命名空间中配置，默认使用 PATH 中的 `pdfinfo`、`pdftotext`。可执行文件路径只允许由 application 设置覆盖，空间和会话不能指定本机程序。Ubuntu 可通过系统渠道安装 `poppler-utils`；没有安装时只影响 PDF，其余格式可用。

CPU 解析使用独立 worker。PDF 通过直接子进程执行，取消时先终止，必要时强制结束，等待 `close` 后再清理临时原件。取得原件快照后就退出共同内容队列，解析期间其他内容可以保存。

材料包当前没有接入命令执行服务的沙箱。后台代码以宿主权限运行，Poppler 直接继承宿主执行环境；配置作用域检查只控制谁能指定程序，不隔离该程序本身。具体范围与搜索入口见[搜索和材料说明](../../docs/development/search-materials.md)。

提取结果可重新生成，包没有业务数据库或持久缓存。需要长期维护的校订稿、批注和笔记使用内容工具另行保存，后续提取不覆盖它们。在线获取、OCR、视觉与音视频的当前范围见[未完成项与待验证项](../../docs/development/search-materials.md#未完成项与待验证项)。

## 验证边界

测试通过编译包、Pi 包发现和 RepaClient 使用实际解析器。样本包括两页 PDF、PNG、HTML、Markdown、文本和代码，覆盖资源与修订、缺少工具、损坏文件、范围限制、取消，以及重提取后人工稿的保留。

配置检查覆盖空间或会话试图设置 PDF 命令的情况。PDF 生命周期测试用一个执行真实 `pdftotext` 的 wrapper，通过 FIFO 控制退出时机，观察取消是否等待实际结束；这个 wrapper 只用于测试，不进入分发包。

主包与材料包曾在仓库外通过本地 tgz 安装，实际运行后台提取和编译 worker。验证使用本地提供的宿主依赖，当前尚未从公共 registry 发布主 Repa 包。
