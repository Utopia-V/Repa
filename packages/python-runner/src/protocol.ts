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
export const PYTHON_BATCH = "repa-python-batch-v2";
/** 前端服务的名字。前端连接时在 capabilities.services 里声明它，就表示能运行 Python。 */
export const PYTHON_RUN = "python.run";
const pythonError = object({ type: Type.String(), message: Type.String() });

/** 实际加载的 Pyodide、Python 和 numpy、pandas 的版本，只随结果记下，调用方不拿它比较。 */
export const RuntimeSchema = object({
  pyodide: Type.String(),
  python: Type.String(),
  packages: Type.Record(Type.String(), Type.String()),
});
/** 实际加载的运行环境，见 RuntimeSchema。 */
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
});
/** 一个测试运行完的结果，见 PythonProgramResultSchema。 */
export type PythonProgramResult = Static<typeof PythonProgramResultSchema>;

/**
 * 一个测试：在全新的命名空间里依次运行 prelude、准备 data、运行 setup 和 program，再对 captures 逐个求值、逐条运行 doctest。
 * 测试只带运行所需的输入，怎样比较由调用方决定。program 可以是空串，这时只在准备好的命名空间里对 captures 求值。
 */
export const PythonTestSchema = object({
  id: Type.String(),
  program: Type.String(),
  prelude: Type.String(),
  setup: Type.String(),
  data: Type.Array(object({ label: Type.String(), fixture: FixtureSchema })),
  captures: Type.Array(Type.String()),
  doctest: Type.Array(Type.String()),
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

/** tests 与输入一一对应、顺序相同。某个测试让这一批停下（见 endsBatch）以后，余下的测试都是 not_run，此前没有 not_run。 */
export const PythonBatchResultSchema = object({
  protocol: Type.Literal(PYTHON_BATCH),
  runtime: RuntimeSchema,
  tests: Type.Array(PythonTestResultSchema),
});
/** 一批测试的结果，见 PythonBatchResultSchema。 */
export type PythonBatchResult = Static<typeof PythonBatchResultSchema>;

/** 这个结果之后这一批是否停下：超时和失败会停下；恢复解释器状态失败不停，余下的测试换一个解释器接着运行。 */
export function endsBatch(result: PythonTestResult): boolean {
  return result.status !== "completed";
}
