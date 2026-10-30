/**
 * python.run 的输入输出：调用方把一批 Python 测试交给前端，前端在隔离的 Worker 里依次运行，交回每个测试的结果。
 *
 * 本文件经 @repa/python-runner/protocol 导出，只依赖 typebox 和 @repa/base/protocol，浏览器里也能用。
 * 发送方按当前版本严格校验，多余字段直接拒绝；协议名变了才改格式，前端认不出协议名就拒绝。
 */
import { Type, type Static } from "typebox";

import { object } from "@repa/base/protocol";

/** 请求与结果都带这个协议名；前端认不出就拒绝，不按旧格式猜。 */
export const PYTHON_BATCH = "repa-python-batch-v1";
const pythonError = object({ type: Type.String(), message: Type.String() });

/**
 * 运行环境：Pyodide、Python 和包的版本。请求里是调用方期望的环境，结果里是实际加载的。
 * prelude 是每个任务在自己的命名空间里先运行的代码，只出现在请求里。
 */
export const RuntimeSchema = object({
  pyodide: Type.String(),
  python: Type.String(),
  packages: Type.Record(Type.String(), Type.String()),
  prelude: Type.Optional(Type.String()),
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
 * 一个测试运行完的结果，即 runner.py 的 program 任务的结果：error 是 program 抛出的异常，line 是它停在第几行；
 * captures 的 value 是 runner.py 序列化后的值（无法可靠比较时含 too_large 标记）；doctest 按输入顺序给出每条的输出或异常。
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

/** 探测：前端回答它实际能提供的运行环境，不运行代码。 */
export const PythonCapabilitiesRequestSchema = object({
  protocol: Type.Literal(PYTHON_BATCH),
  kind: Type.Literal("capabilities"),
});

/** 探测的回答：runtime 是实际加载的 Pyodide、Python 和包版本；runner 是 runner.py 的 contentVersion。 */
export const PythonCapabilitiesSchema = object({
  protocol: Type.Literal(PYTHON_BATCH),
  runtime: RuntimeSchema,
  runner: Type.String(),
  freshInterpreter: Type.Literal(true),
});

/**
 * 一个测试，与 Node 宿主的 program 任务相同：在全新的命名空间里依次运行 prelude、准备 data、运行 setup 和 program，
 * 再对 captures 逐个求值、逐条运行 doctest。测试只带运行所需的输入，比较用的期望留在调用方。
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
 * 一批测试，前端在一个全新的 Worker 里按顺序执行。submissionId、gradeRevision 是调用方的标识，原样带回；
 * runtime 和 runner 是调用方期望的环境，前端在结果里报告实际的，由调用方核对。
 */
export const PythonBatchInputSchema = object({
  protocol: Type.Literal(PYTHON_BATCH),
  kind: Type.Literal("execute"),
  submissionId: Type.String(),
  gradeRevision: Type.Integer({ minimum: 1 }),
  runtime: RuntimeSchema,
  runner: Type.String(),
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

/** tests 与输入一一对应、顺序相同。某个测试超时或失败后整批停止，之后的测试是 not_run。 */
export const PythonBatchResultSchema = object({
  protocol: Type.Literal(PYTHON_BATCH),
  submissionId: Type.String(),
  gradeRevision: Type.Integer({ minimum: 1 }),
  runtime: RuntimeSchema,
  runner: Type.String(),
  freshInterpreter: Type.Literal(true),
  tests: Type.Array(
    Type.Union([
      object({ id: Type.String(), status: Type.Literal("completed"), result: PythonProgramResultSchema }),
      object({ id: Type.String(), status: Type.Enum(["timeout", "failed"]), phase: PythonPhaseSchema, error: Type.Optional(pythonError) }),
      object({ id: Type.String(), status: Type.Literal("not_run") }),
    ]),
  ),
});
/** 一批测试的结果，见 PythonBatchResultSchema。 */
export type PythonBatchResult = Static<typeof PythonBatchResultSchema>;
/** 一个测试的结果：completed、timeout、failed 或 not_run。 */
export type PythonTestResult = PythonBatchResult["tests"][number];

/** 前端服务 python.run 收到的输入：探测或执行一批测试。服务只在什么都没有运行时以错误回复。 */
export const PythonRunInputSchema = Type.Union([PythonCapabilitiesRequestSchema, PythonBatchInputSchema]);
/** python.run 的输入，见 PythonRunInputSchema。 */
export type PythonRunInput = Static<typeof PythonRunInputSchema>;
