# 写课说明

这份说明给写课的 Agent 和社区作者：按这个格式写一个 topic，要满足什么，怎样自查。字段的完整定义在 [`src/format/schema.ts`](../src/format/schema.ts)，现成的例子是 [`py01`](python/topics/py01.yaml)（追踪与预测）、[`py12`](python/topics/py12.yaml)（写清需求，不用代码）和 [`py17`](python/topics/py17.yaml)（pandas 读表、小改代码）。

## 文件放在哪里

- `courses/<课程>/course.yaml`：课程清单，写课程 id、版本、判分运行时、来源登记和 topic 列表。
- `courses/<课程>/topics/<topic id>.yaml`：每个 topic 一个文件，文件名就是 id。新增 topic 时，同时把 id 加进清单的 `topics`。

## 一个完整的 topic

一个 topic 是一节约 20 分钟的课（`minutes`），含 2–4 个知识点。只写了名称、知识点、先修和来源的骨架是 `status: outline`；内容写齐后改成 `status: complete`，这时检查会要求每个知识点都有：

| 字段 | 要求 |
| --- | --- |
| `card` | 概念卡：`name` 短名称（对话里提到时作链接文字），`definition` 一句话定义，`conditions` 1–3 条适用条件或常见混淆，`example.from` 指向本知识点的例题或练习题（原学习位置），`example.text` 是那个例子的简短回顾 |
| `lesson` | 讲解，Markdown |
| `example` | 例题，带完整解析；展示后不计学习证据 |
| `practice` | 至少 3 道练习 |
| `review`、`quiz` | 复习题池和测验题池，各至少 1 道，建议各 2 道 |

复习和测验题要脱离讲解独立作答，所以：

- 考同一个机制，但换题型、情境和数据，不要只换几个数字和名字，也不要沿用练习题的选项原文；
- 至少有一个由程序判分的作答位；不能放 `rubric`（由人或模型评）的开放作答题。

`intro`、`wrapup` 是开场和收束的话；`notes` 是写给作者的备注（范围、节奏、题型安排），学习者看不到。

讲解和题目都要自己写。外部材料登记在清单的 `sources`，topic 的 `sources` 写清用了哪一章哪一节、怎样用：`reference` 是只作取材参照、内容自行编写；`adapt`、`code`、`quote` 分别是改编文字、复用代码和短引用，必须写 `notice`，并且只能用在该材料许可允许的范围内。Python for Data Analysis 的正文只能 `reference`。

## id 与版本

- 知识点 id 写成 `<topic id>.k<数字>`，题目 id 写成 `<知识点 id>.<小写字母><数字>`。习惯上例题用 `e0`，练习用 `q1`、`q2`…，复习用 `r`，测验用 `x`。
- id 是稳定身份，题目换了题池也不改 id。题目实质换了内容，就给新 id。
- 题目版本由检查程序算出，是学生看到什么、怎样判的内容哈希：题面、作答位（含答案和判分规则）、解析、测试，加上用到的数据。`kind`、`measures`、`uses` 这些元数据，以及只为检查而写的 `verify`、`manual` 和代码题的 `accepts`、`rejects`，都不影响版本；topic 末尾的核对记录 `verified` 也不影响。不用手写版本。

## 内容怎样写

凡是题面、讲解、选项、解析的位置都可以直接写 Markdown：

- 从第一列开始的 ```` ```python ```` 代码块会成为单独的代码块；写成 ```` ```python startLine=1 ```` 显示行号，题目里就能说“第 3 行”。
- 提到学过的概念时写 `[布尔掩码](repa:concept/py17.k1)`，指向知识点 id。链接只能用 `https:` 和 `repa:concept/`，不用 `![]()` 插图。
- 选项的顺序可能在交付时被打乱：正确选项不要总放在同一个位置，解析里按内容指称选项，不要说“第二个”。

## 题目怎样写

一道题是题面 `body` 加若干作答位 `slots`，再加解析 `explanation`。作答位是交互词汇的五种形状，答案写在作答位上：

| 作答位 | 用于 | 答案与判分 |
| --- | --- | --- |
| `choice` | 单选、多选、判断 | `key` 单选写一个选项 id，多选写 id 列表；多选的正确答案可能一项都不选时加 `minSelected: 0`。多选加 `scoring: options` 时每个选项的勾选状态各 1 分。选项可带 `feedback`，选错时给出 |
| `text` | 数值、短答、Python 显示内容、开放说明 | `key` 写一个或多个可接受的值。`format: integer` 时按整数比较（字符串答案如“尚未定义”按原文比较）；`match: text` 去掉首尾空白逐字比较，学生多加的一对引号不算错；`match: output` 按 Python 显示内容比较，`'a'` 与 `"a"` 相同，`True` 与 `1`、`6` 与 `6.0` 不同，字典按显示顺序比较，标准答案恰好是 `NOTHING`、`ERROR`、`FUNCTION` 时不分大小写；`match: nonempty` 只要求非空。`match` 为 text、output 时，`key` 和 `feedback` 的 `when` 都写成带引号的文字。开放作答写 `rubric` 而不写 `key`，只能放在例题和练习里 |
| `order` | 排序、选出并排序、Parsons | `items` 每块写 `content` 或一行 `code`；`partial: true` 允许留下不用的块；`key` 是标准排列，`alternatives` 是其他正确排列。要排缩进时加 `indent`（最大层级）和 `indents: {块 id: 层级}`，缩进按块计，并且要加 `tests` 按测试判。一块都不选按没答处理，所以正确答案可能为空时，改问行数 |
| `table` | 追踪表、逐行掩码、WWPD | `columns` 里给作答列加 `input`：`bool`（True/False）、`integer`、`text`，或完整写法 `{ type: text, format, quick, match }`。在作答列里，单元格直接写的值就是这一格的答案；在其他列里，写的是固定显示的文字，要写成带引号的字符串 |
| `code` | 小改代码、骨架加 doctest | `starter` 是作答框里的初始代码，`solution` 是参考答案，`accepts` 是其他应通过的写法，`rejects` 是常见错误写法（每份写 `why`），`tests` 是测试 |

题目用到的小表写在 topic 的 `data` 里：`kind: dataframe` 给出 `name`（变量名）、`index`、`columns`，题目写 `data: [T]` 时表格会显示在题面最前面，核对和测试也会准备好这个变量；不讲 pandas 的题加 `showIndex: false`。YAML 把 `1.0` 读成和 `1` 一样的数，写了小数的列要在 `dtypes` 里声明为 `float`（表格里也会显示成 `1.0`）；`001` 这样的编号要加引号。`kind: python` 是一段准备代码，`display` 是题面里给学生看的说明。

测试由 `data` 和 `setup` 准备输入，然后运行作答代码，再比较：

- `expect`：键是作答运行后求值的表达式，值是期望结果的表达式（在只有 data 和 setup 的全新环境里求值，可用 `pd`、`np`）。写一项 `df: df` 就能检查原表没有被改。
- `doctest`：`>>> ` 后是语句，下一行是交互解释器应显示的内容；`>>>` 和 `...` 后面要有一个空格。
- `stdout`：作答打印的全部内容。
- `hidden: true` 的测试只告诉学生通过与否。至少留一个公开测试。

测试要能分出常见错误：`rejects` 里的每份错误写法，以及作答框里的 `starter`，都必须在某个测试上失败；`accepts` 里的写法必须通过全部测试。测试的数据不要恰好让错误写法也得出对的结果，例如表已经按编号排好时，多加一次排序也查不出来。

## 核对：每个答案都要独立算一遍

诊断、测验和复习用的题必须核对过；能用程序核对的，用程序独立算一遍，程序算不出的，让模型独立再解一遍。每道题的每个作答位只能是下面三种之一：

1. **`verify` 程序核对。** 一段在 Pyodide 里运行的 Python，结束时给 `answers` 赋值 `{作答位 id: 算出的答案}`。检查程序把算出的值当作一份作答，按作答位自己的判分规则去判，必须判对；`key` 里另写的每个可接受值也要与算出的答案一致。有多种正确排列的排列题无法这样核对，改用 `tests` 或列进 `manual`。
2. **`manual` 程序算不出的作答位。** 答案要靠语义判断、写不出核对程序的作答位（例如把自然语言要求填成字段），列进 `manual`。复习和测验题里的这些作答位用 `npm run course:confirm` 核对：只把学习者看得到的题面交给模型（默认 DeepSeek flash），不给答案和解析，让它按作答位的格式独立作答，再用作答位自己的判分规则比对。全部一致时，在 topic 文件末尾的 `verified` 段记下题目 id、当时的版本、模型和日期；不一致时只列出差异，不记录，由人判断是题面有歧义、答案错了，还是模型错了。题目一改，版本就变，旧记录随之失效，`course:check` 会要求重新核对。例题和练习里的 `manual` 不强制核对。
3. **测试负责。** 代码题、带 `tests` 的排列题和开放作答不用 verify。

`verify` 里可以用：

| 名字 | 含义 |
| --- | --- |
| `CODE` | 题面里全部 python 代码块拼成的程序；`BLOCKS` 是逐块的列表 |
| `OPTIONS` | `{作答位: {选项 id: 选项里的代码}}`，用来逐个运行代码选项 |
| `run(code=CODE, **inputs)` | 在全新环境里运行，返回 `.out`（打印内容）、`.lines()`、`.error`（异常类型名或 None）、`.vars`、`r["变量名"]`；`inputs` 是事先赋好的变量，不能取名 `code` |
| `trace(code=CODE, names=[...])` | 逐条运行顶层语句，返回每条执行后这些变量的值（没定义的不在字典里） |
| `repl(code=CODE)` | 像交互解释器那样逐条输入，返回每条的显示内容，沿用 `NOTHING`、`ERROR`、`FUNCTION` |
| `pd`、`np`，以及题目 `data` 里的变量 | 直接可用 |

算出的值写成作答的方式：普通作答里，字符串原样，其他值用 `repr`（`True` 成为 `"True"`，`4` 成为 `"4"`）；`match: output` 的作答里，字符串也取 `repr`（`'42'` 带引号），只有 `.out`、`.lines()`、`repl()` 给出的显示文字原样使用。选择题给选项 id，多选和排列题给 id 列表，表格给 `{行 id: {列 id: 值}}`，只写作答格。核对程序要独立推出答案，不要把标准答案再抄一遍；从选项里挑答案时，先求出全部符合条件的选项，确认恰好一个，例如 `fits = [...]; answers = {"line": fits[0] if len(fits) == 1 else fits}`。

## 判分运行时

核对与测试都在课程清单写明的运行时里运行：Pyodide 314.0.7，Python 3.14.2、pandas 3.0.2、NumPy 2.4.6，与学习者运行代码的环境相同。题目的输出、报错信息和 pandas 行为都以它为准，不能拿本机的 CPython 和 pandas 代替。容易出错的地方：

- pandas 3 的 Copy-on-Write：派生对象的修改不会回写原表，链式赋值不能更新原表。
- pandas 3 的文字列默认是 `str` 类型；`pd.DataFrame({"a": []}, index=[])` 的空列却是浮点。期望一张空表时写 `pd.DataFrame(columns=["a"])`。测试只比较列类型的大类（整数、浮点、布尔、文字或对象等）。
- Python 3.14 的报错信息与旧版本不同；题目问异常时问类型，不问整段信息。
- 超过一万个元素的值不比较，报“太大，无法比较”；测试里改为比较 `.head()`、`.shape` 这类更小的表达式。

## 自查

在仓库根目录：

```sh
npm run course:runtime -- --from <已有离线包的目录>   # 第一次：准备离线 Pyodide 包；不给 --from 时联网下载
npm run course:check                                 # 结构、交叉规则、标准答案和 Pyodide 核对
npm run course:check -- --topic py17                 # 只核对正在写的 topic 的代码，结构仍查整门课
npm run course:check -- --no-run                     # 只查结构，不运行代码
npm run course:confirm -- --topic py12 --dry-run     # 看要发给模型的请求，不调用模型
npm run course:confirm -- --topic py12               # 模型核对复习和测验题里的 manual 作答位，会产生费用
```

`course:confirm` 经 Repa 底座的 Agent 运行时调用模型，凭据用 `~/.repa/agent/` 里已经登录的（`--agent-dir` 可改），不写进任何文件。已有当前版本记录的题不再发请求；`--max-requests` 限制这次的请求数（默认 50，输出不合格式时重试一次也算在内），`--log` 把请求和模型的作答另存一份 JSONL。

代码核对需要 Linux 的 Landlock（ABI 4 以上）和 libseccomp，在别的系统上只能用 `--no-run`。检查通过之后，再自己读一遍：

- 解析是否讲清了为什么，而不只是重复答案；
- 复习和测验题是不是换了题型和情境、仍然考同一个机制；
- `course:confirm` 列出的不一致各是什么原因。模型答对只说明它从题面读出了同一个答案，题目是否考到了要考的东西，仍要自己看。

YAML 的几个坑：

- `001`、`true`、`10` 这类值要当文字时加引号，例如选项 id `"4"`；
- 含 `: ` 的内容（例如 Python 字典 `{"a": 1}`）整段加引号，一般用单引号；
- 以反引号开头的内容加引号，例如 `` "`sample_id`" ``；
- 多行的讲解、代码和核对程序用 `|` 块；
- 不用锚点和别名，需要共用的数据写成 `data`。
