# 把课件做成课

学习者把课件放进空间的 `materials/`，要你把它做成一门课。课写在空间的 `course/` 里，`course_check` 检查，`course_use` 让学习者用上。学习者的课、复习和测验只用最近一次 `course_use` 换用的那一版，写到一半的文件不会出现在里面。

## 顺序

1. 读 `materials/` 里的材料，弄清范围：有哪些章节，哪些是要会做的，哪些是要记住的。
2. 先出大纲给学习者看：分几节（一节是一个 topic，约 15 至 20 分钟）、每节讲什么、先后关系。等学习者认可，删掉的不做，标了重点的先做。
3. 把大纲写成课：`course.yaml` 列出全部 topic，每个 topic 先写成 `status: outline` 的骨架。
4. 一批一批地做：把几节写成 `status: complete`，运行 `course_check`，按报出的问题逐处改正，直到通过，再运行 `course_use`。
5. 告诉学习者前面几节可以开始学了，后面的接着做，每做完一批重复第 4 步。

`course_use` 时学习者若正在上课、复习或测验，这一次不换用，回复会写明；等他做完再运行一次 `course_use`。

## 文件

- `course/course.yaml`：课程清单。
- `course/topics/<topic id>.yaml`：每个 topic 一个文件，文件名就是 id，id 要列进清单的 `topics`。

`course/` 里别的文件不读，草稿、核对用的笔记可以放在别处。

## 一个完整的例子

同一目录下的 `example-course/` 是一门能通过检查、能上课的小课，写之前先读它的 `course.yaml` 和 `topics/os01.yaml`。清单是这样：

```yaml
id: os-memory          # 字母开头，字母、数字、下划线、连字符；定了就不再改
version: 1.0.0
title: 进程的基本概念
language: zh-CN
license: NOASSERTION
sources: {}
topics: [os01, os02]   # topic id 只用小写字母和数字，字母开头
```

不用 Python 的课不写 `runtime`。

## topic 的要求

- `minutes` 在 5 到 60 之间；`prerequisites` 只列直接先修，指向清单里的 topic，不能成环；`sources` 写 `[]`。
- 每个 topic 2 至 4 个知识点 `kps`。知识点 id 写成 `<topic id>.k<数字>`，题目 id 写成 `<知识点 id>.<小写字母><数字>`，例如 `os01.k1.q1`。
- `status: outline` 的骨架，知识点只写 `id` 和 `title`，不进学习者的菜单。
- `status: complete` 的 topic，每个知识点都要有：`card`（`name` 不超过 24 字、一句话 `definition`、1 至 3 条 `conditions`、`example.from` 指向本知识点的例题或练习题），`lesson` 讲解，`example` 例题，至少 3 道 `practice`，至少 1 道 `review` 和 1 道 `quiz`。
- 讲解和题面用 Markdown。链接只能是 `https:` 或 `repa:concept/<知识点 id>`，不用 `![]()` 插图。

## 题目

一道题是 `body` 题面、`slots` 作答位和 `explanation` 解析。作答位用这几种：

| 作答位 | 写法 |
| --- | --- |
| 选择 | `type: choice`，`options` 每项 `{ id, content }`；单选 `key` 写一个选项 id，多选加 `multiple: true`、`key` 写 id 列表 |
| 填空 | `type: text`；文字答案加 `match: text`，`key` 写一个或几个可接受的写法；数值答案写 `format: integer` 或 `format: number`，`key` 写数 |
| 排序 | `type: order`，`items` 每项 `{ id, content }`，`key` 写正确顺序的 id 列表，要用上全部项 |

复习和测验题要由程序判分，所以只用上面这些有标准答案的作答位，不放开放作答。

每个作答位的答案要么由 `verify` 程序算出，要么列进这道题的 `manual`。

**要计算的答案一律写 `verify`，不用自己心算的结果。** 此前的一次试做里，自写的数值题手算答案五处全错，都是靠程序复算才发现的。`verify` 是一段 Python，最后给 `answers` 赋值 `{作答位 id: 算出的答案}`，检查时在沙箱里运行，算出的答案要与 `key` 一致。例如：

```yaml
- id: os01.k1.q4
  body: 时间片是 20 ms，一个进程要运行 70 ms，它要被调度几次？
  slots:
    - { id: n, type: text, format: integer, key: 4 }
  explanation: 70 除以 20 向上取整是 4。
  verify: |
    import math
    answers = {"n": math.ceil(70 / 20)}
```

写了 `verify` 的课，清单要加下面这段 `runtime`，照抄，不改版本号：核对用的 Python 环境就是这一套，版本或包不符时检查不通过。

```yaml
runtime:
  pyodide: 314.0.7
  python: 3.14.2
  packages: { numpy: 2.4.6, pandas: 3.0.2 }
```

**要记住的内容用选择、填空、排序来考，作答位列进 `manual`**，例如 `manual: [state]`。课件里大约四成知识点是这一类。`manual` 的答案没有程序替你核对，`course_check` 会报出复习和测验题里有多少个，答案要你对照材料确认。

`kind` 是可选的题型标签，自己定，不影响出题和判分。

## 规矩

- **现成的习题只在题面完整、答案能核对时才用。** 课件和卷子里的题常缺条件、缺选项，答案本身也可能错；缺了就补全或改写，答案核对不了就另出。
- **题目 id 是学习记录引用的身份。** 换用过的题，内容实质变了就换一个新 id，旧 id 不再给别的题用。只改答案而题面不变时，学习者过去的作答会按新答案重判。删掉一道题，学习者对它的作答就不再算数。
- **复习和测验题换个情境考同一件事**，不要照抄练习题的题面和选项，学习者要能离开讲解独立作答。
- YAML 里，`true`、`false`、`null`、`001` 这类当文字用的值要加引号（选项 id 也是），含 `: ` 的文字整段加引号；不用锚点和别名。

## 检查

`course_check` 逐处列出问题：文件、行列、错误码和说明，多数说明写了怎样改；问题多时分页，末尾写明下一页的 `offset`。“提醒”不妨碍通过。课里有 `verify` 而核对没能运行时（这台机器建不了沙箱，或缺少离线包），检查不会通过，回复写明这些核对没有运行及原因。
