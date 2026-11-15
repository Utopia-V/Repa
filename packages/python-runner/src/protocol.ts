/**
 * python.run 的输入输出：调用方把一批 Python 测试交给前端，前端在一个全新的解释器里依次运行，交回每个测试的结果。
 *
 * 本文件经 @repa/python-runner/protocol 导出，只依赖 typebox 和 @repa/base/protocol，浏览器里也能用。
 * 发送方按当前版本严格校验，多余字段直接拒绝；协议名变了才改格式，前端认不出协议名就拒绝。
 * Node 宿主的 SandboxRunner.runTests 按同一约定运行测试，所以调用方换执行方时不必改判断。
 */
import { Type, type Static } from "typebox";

import { object } from "@repa/base/protocol";

/** 请求与结果都带这个协议名；前端认不出就拒绝，不按旧格式猜。 */
export const PYTHON_BATCH = "repa-python-batch-v4";
/** 前端服务的名字。前端连接时在 capabilities.services 里声明它，就表示能运行 Python。 */
export const PYTHON_RUN = "python.run";
/** 两个宿主共同的时限：测试的准备、被测代码和收尾各 10 秒。调用方等前端交回结果的期限也由它算出，见 replyDeadlineMs。 */
export const PYTHON_STEP_TIMEOUT_MS = 10_000;
/** 两个宿主启动解释器的时限，60 秒：加载 Pyodide 失败时会一直卡住、不报错，所以启动也要限时。 */
export const PYTHON_START_TIMEOUT_MS = 60_000;

/**
 * 调用方最多等前端多久交回一批 count 个测试的结果：启动解释器和加载测试引入的包各一份启动时限，加上每个测试三段（准备、被测代码、收尾）的时限。
 * 前端自己按这些时限结束卡住的测试；这个期限只防前端本身没有回应。stepMs 是每段的时限，与启动时限按 1 比 6 一起缩放。
 */
export function replyDeadlineMs(count: number, stepMs = PYTHON_STEP_TIMEOUT_MS): number {
  return stepMs * (2 * (PYTHON_START_TIMEOUT_MS / PYTHON_STEP_TIMEOUT_MS) + 3 * count);
}

/**
 * Repa 的 Python 环境带的第三方包（Pyodide 包名），依赖由 pyodide-lock.json 补全。标准库随时可用；
 * 这些包在测试的代码用 import 语句引入时才加载，见 runner.py 的 test_packages。两个宿主带的是同一组。
 */
export const PYTHON_PACKAGES: readonly string[] = ["numpy", "pandas"];

const pythonError = object({ type: Type.String(), message: Type.String() });

/** 运行环境：Pyodide、Python 的版本和环境带的包（PYTHON_PACKAGES）的版本。包在测试引入时才加载，这里列出的是能加载的版本。 */
export const RuntimeSchema = object({
  pyodide: Type.String(),
  python: Type.String(),
  packages: Type.Record(Type.String(), Type.String()),
});
/** 运行环境，见 RuntimeSchema。 */
export type Runtime = Static<typeof RuntimeSchema>;

const scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

/** 一张 DataFrame：按列给出的值，可选行索引；dtypes 里声明为 float 的列转成浮点。 */
export const DataFrameFixtureSchema = object({
  kind: Type.Literal("dataframe"),
  name: Type.String(),
  index: Type.Optional(Type.Array(scalar)),
  columns: Type.Record(Type.String(), Type.Array(Type.Union([scalar, Type.Null()]))),
  dtypes: Type.Optional(Type.Record(Type.String(), Type.Enum(["float"]))),
});

/** 一段准备代码，在任务的命名空间里运行。 */
export const PythonFixtureSchema = object({
  kind: Type.Literal("python"),
  code: Type.String(),
});

/** 运行前准备的数据：一张 DataFrame 或一段准备代码。只含运行要用的字段。 */
export const FixtureSchema = Type.Union([DataFrameFixtureSchema, PythonFixtureSchema]);
/** 运行前准备的数据，见 FixtureSchema。 */
export type Fixture = Static<typeof FixtureSchema>;

/**
 * 一个测试运行完的结果，即 runner.py 的 program_steps 的结果：error 是 program 抛出的异常，line 是它停在第几行；
 * captures 的 value 是 runner.py 序列化后的值（超过上限时是 too_large 标记）；doctest 按输入顺序给出每条的输出或异常。
 */
export const PythonProgramResultSchema = object({
  stdout: Type.String(),
  error: Type.Union([
    object({ ...pythonError.properties, line: Type.Optional(Type.Union([Type.Integer(), Type.Null()])) }),
    Type.Null(),
  ]),
  captures: Type.Record(Type.String(), Type.Union([object({ value: Type.Unknown() }), object({ error: pythonError })])),
  doctest: Type.Array(object({ out: Type.String(), exception: Type.Union([Type.String(), Type.Null()]) })),
  /** 带 verify 的测试才有：verify 程序算出的作答（作答位 id 到按形状写成的值），以及 answers 里不需要核对的作答位。程序出错时没有，错误在 error。 */
  verified: Type.Optional(object({ answers: Type.Record(Type.String(), Type.Unknown()), unknown: Type.Array(Type.String()) })),
});
/** 一个测试运行完的结果，见 PythonProgramResultSchema。 */
export type PythonProgramResult = Static<typeof PythonProgramResultSchema>;

/**
 * 课程核对的 verify 任务要的题目内容：code 是题面代码块连起来的全文，blocks 是各块，options 是 {作答位: {选项: 代码}}，
 * cells 是表格里固定显示的文字 {作答位: {行: {列: 文字}}}，shape 是需要核对的作答位各自写成作答的方式（见 runner.py 的 convert_answer）。
 * 它属于学习插件的课程核对，暂时放在运行器里，见 README 的已知限制。
 */
export const PythonVerifySchema = object({
  code: Type.String(),
  blocks: Type.Array(Type.String()),
  options: Type.Record(Type.String(), Type.Record(Type.String(), Type.String())),
  cells: Type.Record(Type.String(), Type.Record(Type.String(), Type.Record(Type.String(), Type.String()))),
  shape: Type.Record(Type.String(), Type.Unknown()),
});

/**
 * 一个测试：在全新的命名空间里依次运行 prelude、准备 data、运行 setup 和 program，再对 captures 逐个求值、逐条运行 doctest。
 * 测试只带运行所需的输入，怎样比较由调用方决定。program 可以是空串，这时只在准备好的命名空间里对 captures 求值。
 * 带 verify 时是课程核对的 verify 任务：program 是 verify 程序，在带有运行题面代码的辅助函数的命名空间里运行，
 * 不用 setup、captures 和 doctest，结果在 verified 里。
 */
export const PythonTestSchema = object({
  id: Type.String(),
  program: Type.String(),
  prelude: Type.String(),
  setup: Type.String(),
  data: Type.Array(object({ label: Type.String(), fixture: FixtureSchema })),
  captures: Type.Array(Type.String()),
  doctest: Type.Array(Type.String()),
  verify: Type.Optional(PythonVerifySchema),
});
/** 一个测试，见 PythonTestSchema。 */
export type PythonTest = Static<typeof PythonTestSchema>;

/**
 * 一批测试。前端每次调用用一个全新、没有运行过别的代码的解释器，按顺序运行，测试之间由 runner.py 恢复常被改动的全局状态；
 * 恢复失败时换一个全新的解释器运行余下的测试。请求里只有测试本身，不带调用方的标识；调用方自己把结果对应回用途。
 */
export const PythonBatchInputSchema = object({
  protocol: Type.Literal(PYTHON_BATCH),
  tests: Type.Array(PythonTestSchema),
});
/** 一批测试，见 PythonBatchInputSchema。 */
export type PythonBatchInput = Static<typeof PythonBatchInputSchema>;

/**
 * 测试停在哪个阶段。program、capture、doctest 运行的是被测的代码，这些阶段的超时属于测试结果；
 * prepare（前导、夹具、setup）和 cleanup 的超时，以及任何阶段的 failed，都属于执行失败。
 */
export const PythonPhaseSchema = Type.Enum(["prepare", "program", "capture", "doctest", "cleanup"]);
/** 测试停在的阶段，见 PythonPhaseSchema。 */
export type PythonPhase = Static<typeof PythonPhaseSchema>;

/**
 * 一个测试的结果。completed 带上运行结果；有 restoreError 时结果照样有效，只是之后恢复解释器状态失败，
 * 余下的测试换了一个新的解释器运行。timeout 与 failed 写明停在的阶段，not_run 是没有运行。
 */
export const PythonTestResultSchema = Type.Union([
  object({ id: Type.String(), status: Type.Literal("completed"), result: PythonProgramResultSchema, restoreError: Type.Optional(pythonError) }),
  object({ id: Type.String(), status: Type.Enum(["timeout", "failed"]), phase: PythonPhaseSchema, error: Type.Optional(pythonError) }),
  object({ id: Type.String(), status: Type.Literal("not_run") }),
]);
/** 一个测试的结果，见 PythonTestResultSchema。 */
export type PythonTestResult = Static<typeof PythonTestResultSchema>;

/**
 * tests 与输入一一对应、顺序相同。某个测试让这一批停下（见 endsBatch）以后，余下的测试都是 not_run，此前没有 not_run。
 * loaded 是这一批运行过的测试引入、因而加载的包（包名，按名字排序，不列依赖）；它只由测试的代码决定，两个宿主相同。
 */
export const PythonBatchResultSchema = object({
  protocol: Type.Literal(PYTHON_BATCH),
  runtime: RuntimeSchema,
  loaded: Type.Array(Type.String()),
  tests: Type.Array(PythonTestResultSchema),
});
/** 一批测试的结果，见 PythonBatchResultSchema。 */
export type PythonBatchResult = Static<typeof PythonBatchResultSchema>;

/** 这个结果之后这一批是否停下：超时和失败会停下；恢复解释器状态失败不停，余下的测试换一个解释器接着运行。 */
export function endsBatch(result: PythonTestResult): boolean {
  return result.status !== "completed";
}
