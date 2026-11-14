# 课件转文字插件

## 概述

`@repa/materials` 把空间 `materials/` 下的 PDF、幻灯片和 Word 文档读成按页、张或段标号的文字，交给通用 Agent 做课。

## 怎么用

### 装配

学习者把课件放进空间的 `materials/`，Agent 做课时要读它们。底座的 read 工具把文件按 UTF-8 解码，PDF 和幻灯片读出来是乱码，所以本插件另给两个工具，解析这些格式的库随包附带，学习者的机器上不必装别的程序。

底座按包根的 `repa-plugin.json` 加载本插件，插件 id 为 `materials`，入口是构建后的 `dist/plugin.js`。它是随产品附带的 npm 包，普通版本与学习者版本都加载：根目录的 `npm start`、`npm run dev:backend`、`npm run dev:learning`，Web 开发服务器起的后端，以及桌面端的 [learner.ts](../../apps/desktop/src/main/learner.ts)。桌面安装包经 [package-application.mjs](../../apps/desktop/scripts/package-application.mjs) 的包清单装进本包，[verify-application.mjs](../../apps/desktop/scripts/verify-application.mjs) 核对它的清单与 CMap 数据在安装包里，并确认后端加载后它在运行。

### 工具

| 工具 | 参数 | 结果 |
| --- | --- | --- |
| `materials_list` | 无 | `materials/` 下每个文件一行：格式与页数、张数或段数；读不出文字的写明原因；文字文件提示用 read 直接读 |
| `materials_read` | `path`（相对空间根目录），可选 `from`、`to` | 从 `from` 起逐页、逐张或逐段给出文字，每块前标 `〔第 N 页〕`、`〔第 N 张〕` 或 `〔第 N 段〕` |

`materials_read` 一次最多交回 40,000 字节、1,500 行，留在底座 50 KiB、2,000 行的[工具输出上限](../base/README.md#处理工具输出)之内，所以模型拿到的总是整页、整张或整段。读到上限时，结果末尾写明还有哪些没读、下次 `from` 填几；指定了 `to` 而后面还有内容时，也写明后面还有多少。单独一页就超过上限时整页给出，由底座把全文存进工具输出文件，模型再用 read 续读。

`path` 只能指 `materials/` 里的文件，指到别处时错误码为 `file_outside_materials`，空间的 `.repa/`（历史、会话、别的插件的数据）因此也读不到；经符号链接指到空间外的为 `file_outside_space`，文件不在时为 `file_not_found`，`from` 超出总数时为 `invalid_range`。

### 读不出文字时

读不出文字的文件不交回空白或乱码，而是一句能转述给学习者的原因：

| 情形 | 原因 |
| --- | --- |
| PDF 每一页都没有文字层 | 可能是扫描件或图片 |
| PDF 的文字全是私用区字符 | 字体没有给出字符对照，读出来是乱码 |
| 幻灯片或 Word 文档里没有文字 | 内容可能都在图片里 |
| PDF 设了打开密码，PPTX、DOCX、PPT、DOC 加密 | 去掉密码后再放进来 |
| Word 95、PowerPoint 95 及更早的格式 | 另存为 DOCX 或 PPTX 后再放进来 |
| 其他格式，例如图片、Excel | 不支持 |
| 解析时出错 | 文件损坏或不完整，括号里附上解析库的说明 |
| 零字节的文件，例如复制中断留下的 | 文件损坏或不完整，括号里写“文件是空的” |

PDF 里有文字的页照常读出，个别没有文字或读出乱码的页在该页位置写明，页码不因此错位。

## 怎么实现

### 分辨格式

插件看文件开头的字节，不看扩展名：`%PDF-` 是 PDF，zip 包按其中有 `ppt/presentation.xml` 还是 `word/document.xml` 分成 PPTX 与 DOCX，OLE 复合文档按其中的流分成 PPT、DOC 与加密的 OOXML。不是这些而能按 UTF-8 解码、不含零字节的，是文字文件。改错扩展名的文件因此照样能读。

### 各格式的读法

- **PDF** 用 [unpdf](https://github.com/unjs/unpdf) 内置的 pdf.js 逐页取文字层，按 pdf.js 给出的行尾分行。中文 PDF 若用不嵌入字体的预定义 CMap 编码（如 `UniGB-UCS2-H`、`GBK-EUC-H`），pdf.js 要读 CMap 数据才知道每个字节是哪个字，否则读成空白；unpdf 不带这些数据，本包的 `cmaps/` 放着取自同版本 `pdfjs-dist`（6.5.438）的 Adobe CMap，许可证为 BSD-3-Clause，见其中的 `LICENSE`。升级 unpdf 时，按它内置的 pdf.js 版本换上对应的 `cmaps/`。
- **PPTX、DOCX** 用 fflate 只解压需要的部件，再按元素顺序取文字元素 `a:t`、`w:t` 的内容。幻灯片按 `presentation.xml` 的放映次序排，不按文件名；页码、日期、页脚占位符每张都有，略去。Word 文档表格外的每个段落为一段，表格的每一行为一段，格子之间用 ` | ` 隔开；`mc:Fallback` 是同一内容给旧程序看的副本，略去，文本框的字因此不读两遍。图片在所在位置记为 `[图片]`。
- **PPT** 按 [MS-PPT] 从 `Current User` 找到最近一次保存，沿保存链合成持久对象目录，再按 `SlideListWithText` 的次序逐张遍历形状：占位符的文字经 `OutlineTextRefAtom` 取回，文本框的文字直接在形状里，页码、日期和页脚占位符略去。
- **DOC** 按 [MS-DOC] 的分段表拼出正文的 `ccpText` 个字符，域只留结果，段落按段落标记分开，表格单元标记换成 ` | `。

复合文档由本包的 [`compound-file.ts`](src/compound-file.ts) 读取，扇区链的长度不超过文件的扇区数，目录树的项不重复访问，坏文件因此报错而不会一直读下去。

### 缓存

转换结果以源文件内容的 SHA-256 为键，存在插件数据目录的 `cache/<版本>-<摘要>.json`，同一份内容换了名字、挪了位置也不再解析。每次列出或读取都重读文件、重算摘要，文件原地换了内容也读出新的；一个 174 MB 的文件约需 110 ms。转换的写法改变时，`materials.ts` 的 `CONVERTER_VERSION` 加一，文件名随之改变，旧缓存不再命中。写入先写临时文件再改名，盘上不会留下半份缓存。

插件只读空间文件，不写 `materials/`，也不写空间里别的地方。

### 验证

在仓库根目录运行 `npm test --workspace=@repa/materials`。测试用到的文件都在测试里现造，唯一的固定样本 `test/fixtures/encrypted.pdf` 是 mutool 1.23 以 AES-128 加密的一页 PDF。

| 测试 | 检查什么 |
| --- | --- |
| `formats.test.ts` | 五种格式各自的读法与次序，不嵌入字体的中文 PDF 靠 CMap 读出，各种读不出文字的情形得到对应原因，扇区链成环的复合文档报损坏而不卡住 |
| `plugin.test.ts` | 两个工具的输出，含零字节文件；长文档分批读时每批在上限内、拼起来不丢段不重段；工具不写空间，同一内容只解析一次（数解析次数），缓存跨实例有效，文件原地换了内容读出新的；`materials/` 外的路径与指向空间外的链接被拒绝 |

## 对模型的影响

- 模型所见：通用 Agent 的系统提示多一段插件说明，130 个字符，约 100 token：课件在 `materials/`，用这两个工具读，不要用 read 直接读 PDF 和幻灯片，读不出时把原因告诉学习者。
- 工具声明两项，描述与参数说明合计约 350 个字符，随插件列表固定在前缀里，不影响提示缓存。
- `materials_read` 的结果每次最多约 40,000 字节，中文约一万多 token；`materials_list` 每个文件一行。

## 已知限制与暂缓

- 扫描件和图片里的文字读不出，只报告原因；要读，需要本机识别或交给能看图的模型，由[里程碑一](https://github.com/Utopia-V/repa/issues/54)之后的工作接续。
- Word 文档没有固定的分页，按段而不按页标号；自动编号（“1.”“（一）”这类由列表格式生成的编号）不在正文里，读不出来。DOC 的表格只能按单元格标记切分，空格子可能把一行切成几段。DOC 的页眉、脚注和文本框，PPTX 的演讲者备注，都不读。
- PPT 幻灯片上的页码域按原样读出为 `*`，例如“第*页”。
- 判断乱码只看私用区字符、替换符与控制字符所占的比例（30%，Repa 的假设）；字体映射到普通字母的乱码看不出来，会当作文字交回。
- `cache/` 里的缓存不会自动删除：课件删掉以后，它的缓存仍留在数据目录。
- PDF 在后端进程里逐页解析，没有放进 worker。在一门操作系统课的真实课件上，三百多页的扫描版 PDF 解析不到一秒，更大的文件会使后端在解析期间响应变慢；每页之间检查一次取消。
- unpdf 2.2.0 声明的引擎是 Node 24 以上，仓库还支持 Node 22.22。仓库不支持的 Node 22.19 把 cp1252 的 0x80–0x9F 解成控制字符，DOC 测试在它上面失败。
