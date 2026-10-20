"""课程检查在 Pyodide 里执行的部分，由 runner.mjs 加载。

每个任务用全新的命名空间（先运行课程清单声明的运行前导），全新的工作目录，
任务后把解释器里常被改动的全局状态（pandas 与 NumPy 的选项、builtins、sys 的输出与显示钩子和 path、
环境变量、warnings 过滤器、挂起的 asyncio 任务、工作目录与临时目录里新建的文件）恢复原样。
模块本身仍在任务之间共享，所以检查程序每个 topic 换一个新运行器；这只为节省启动时间，不是安全边界
（安全边界在 launch.py）。这里只负责执行和把结果序列化，是否正确由沙箱外的 TypeScript 比较。
"""

import ast
import asyncio
import builtins
import contextlib
import copy
import importlib.metadata
import inspect
import io
import json
import os
import shutil
import sys
import traceback
import types
import warnings

import numpy as np
import pandas as pd

OUTPUT_LIMIT = 64 * 1024
# 超过这么多元素或这么长 repr 的值不序列化：截断后两个不同的结果可能看起来一样。
CELL_LIMIT = 10_000
REPR_LIMIT = 20_000


# ---------------------------------------------------------------------------
# 任务之间恢复的全局状态
# ---------------------------------------------------------------------------

BUILTINS = dict(vars(builtins))
# pd.reset_option("all") 会触发每个选项的回调，其中有的在 Pyodide 里会出错；只恢复被改过的选项。
PANDAS_OPTIONS = {key: pd.get_option(key) for key in pd._config.config._registered_options}
PRINT_OPTIONS = np.get_printoptions()
NUMPY_ERRORS = np.geterr()
WARNING_FILTERS = list(warnings.filters)
STREAMS = (sys.stdout, sys.stderr, sys.displayhook)
SYS_PATH = list(sys.path)
ENVIRONMENT = dict(os.environ)
# 工作目录是 Pyodide 默认的 /home/pyodide；这些目录里任务新建的东西在任务后删掉，下一个任务看到的是空目录。
HOME = os.getcwd()
SCRATCH_DIRECTORIES = ("/tmp", HOME)
SCRATCH_BASELINE = {directory: set(os.listdir(directory)) for directory in SCRATCH_DIRECTORIES}
ROOT_BASELINE = set(os.listdir("/"))


def remove_path(path):
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    else:
        os.remove(path)


def clear_scratch():
    """回到工作目录，删掉任务在工作目录、/tmp 和根目录下新建的文件与目录。"""
    os.chdir(HOME)
    for directory, baseline in SCRATCH_BASELINE.items():
        for name in os.listdir(directory):
            if name not in baseline:
                remove_path(os.path.join(directory, name))
    for name in os.listdir("/"):
        if name not in ROOT_BASELINE:
            remove_path(os.path.join("/", name))


def reset_state():
    try:
        restore_state()
    except Exception as error:  # noqa: BLE001  恢复失败时由外层结束运行器，下一个任务换新的
        raise SystemExit(f"无法恢复解释器状态：{error}") from error


def restore_state():
    for name in list(vars(builtins)):
        if name not in BUILTINS:
            delattr(builtins, name)
    for name, value in BUILTINS.items():
        if getattr(builtins, name, None) is not value:
            setattr(builtins, name, value)
    sys.stdout, sys.stderr, sys.displayhook = STREAMS
    sys.settrace(None)
    sys.path[:] = SYS_PATH
    os.environ.clear()
    os.environ.update(ENVIRONMENT)
    clear_scratch()
    warnings.filters[:] = WARNING_FILTERS
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for key, value in PANDAS_OPTIONS.items():
            if pd.get_option(key) is not value and pd.get_option(key) != value:
                pd.set_option(key, value)
    np.set_printoptions(**PRINT_OPTIONS)
    np.seterr(**NUMPY_ERRORS)
    with contextlib.suppress(RuntimeError):
        for task in asyncio.all_tasks(asyncio.get_event_loop()):
            task.cancel()


class OutputTooLong(Exception):
    pass


class LimitedOutput(io.StringIO):
    """捕获 print 输出，超过上限就中止，防止无限输出占满内存。"""

    def write(self, text):
        if self.tell() + len(text) > OUTPUT_LIMIT:
            raise OutputTooLong(f"输出超过 {OUTPUT_LIMIT // 1024} KiB")
        return super().write(text)


def describe_error(error):
    return {"type": type(error).__name__, "message": str(error)[:2000]}


def error_line(error, filename):
    """异常停在 filename 这段代码的第几行：语法错误取它自己的行号，其余取调用栈里最里面一层属于这段代码的行。"""
    if isinstance(error, SyntaxError) and error.filename == filename:
        return error.lineno
    line = None
    for frame in traceback.extract_tb(error.__traceback__):
        if frame.filename == filename:
            line = frame.lineno
    return line


def run_quietly(code, namespace, filename):
    """执行代码并捕获输出；返回 (输出, 异常描述或 None)，异常描述里的 line 是它停在这段代码的第几行。"""
    output = LimitedOutput()
    error = None
    with contextlib.redirect_stdout(output):
        try:
            exec(compile(code, filename, "exec"), namespace)
        except BaseException as caught:  # noqa: BLE001  作答代码可能 exit()，也要记下来
            error = {**describe_error(caught), "line": error_line(caught, filename)}
    return output.getvalue(), error


def build_namespace(data, prelude=""):
    """全新的命名空间：先运行课程清单的运行前导，再准备题目的数据。"""
    namespace = new_namespace(prelude)
    load_data(namespace, data)
    return namespace


def new_namespace(prelude=""):
    namespace = {"__name__": "__main__", "__builtins__": builtins}
    if prelude:
        output, error = run_quietly(prelude, namespace, "<prelude>")
        if error:
            raise RuntimeError(f"课程清单的运行前导出错：{error['type']}: {error['message']}")
    return namespace


def load_data(namespace, data):
    for fixture in data:
        if fixture["kind"] == "dataframe":
            frame = pd.DataFrame(fixture["columns"], index=fixture.get("index"))
            for column, dtype in fixture.get("dtypes", {}).items():
                frame[column] = frame[column].astype({"float": "float64"}[dtype])
            namespace[fixture["name"]] = frame
        else:
            output, error = run_quietly(fixture["code"], namespace, f"<data {fixture['label']}>")
            if error:
                raise RuntimeError(f"数据 {fixture['label']} 的准备代码出错：{error['type']}: {error['message']}")


# ---------------------------------------------------------------------------
# 把 Python 值序列化成可在沙箱外比较的结构
# ---------------------------------------------------------------------------

CONTAINERS = (pd.DataFrame, pd.Series, pd.Index, np.ndarray, list, tuple, set, frozenset, dict)


def element_count(value):
    size = getattr(value, "size", None)
    return int(size) if isinstance(size, (int, np.integer)) else len(value)


def too_large(value, size):
    return {"t": "too_large", "type": type(value).__name__, "size": int(size)}


def canon(value, depth=0):
    if depth > 30:
        return too_large(value, depth)
    if value is None:
        return {"t": "none"}
    if value is pd.NA:
        return {"t": "NA"}
    if value is pd.NaT:
        return {"t": "NaT"}
    if isinstance(value, np.generic) and not isinstance(value, (np.datetime64, np.timedelta64)):
        value = value.item()
    if isinstance(value, bool):
        return {"t": "bool", "v": value}
    if isinstance(value, int):
        return {"t": "int", "v": str(value)}
    if isinstance(value, float):
        return {"t": "float", "v": repr(value)}
    if isinstance(value, str):
        return {"t": "str", "v": value} if len(value) <= REPR_LIMIT else too_large(value, len(value))
    if isinstance(value, CONTAINERS) and element_count(value) > CELL_LIMIT:
        return too_large(value, element_count(value))
    nested = lambda item: canon(item, depth + 1)  # noqa: E731
    if isinstance(value, pd.DataFrame):
        return {
            "t": "DataFrame",
            "index": [nested(label) for label in value.index],
            "columns": [nested(label) for label in value.columns],
            # 只比较类型的大类（整数、浮点、布尔、文字等），文字列是 str 还是 object 存储不算差别。
            "kinds": [dtype.kind for dtype in value.dtypes],
            "values": [[nested(cell) for cell in row] for row in value.itertuples(index=False, name=None)],
        }
    if isinstance(value, pd.Series):
        return {
            "t": "Series",
            "name": nested(value.name),
            "kind": value.dtype.kind,
            "index": [nested(label) for label in value.index],
            "values": [nested(item) for item in value.tolist()],
        }
    if isinstance(value, pd.Index):
        return {"t": "Index", "values": [nested(label) for label in value.tolist()]}
    if isinstance(value, np.ndarray):
        return {"t": "ndarray", "kind": value.dtype.kind, "shape": list(value.shape), "values": nested(value.tolist())}
    if isinstance(value, pd.Timestamp):
        return {"t": "Timestamp", "v": value.isoformat()}
    if isinstance(value, pd.Timedelta):
        return {"t": "Timedelta", "v": str(value)}
    if isinstance(value, list):
        return {"t": "list", "v": [nested(item) for item in value]}
    if isinstance(value, tuple):
        return {"t": "tuple", "v": [nested(item) for item in value]}
    if isinstance(value, (set, frozenset)):
        return {"t": "set", "v": sorted((nested(item) for item in value), key=lambda item: json.dumps(item, sort_keys=True))}
    if isinstance(value, dict):
        return {"t": "dict", "v": [[nested(key), nested(item)] for key, item in value.items()]}
    if isinstance(value, type):
        return {"t": "type", "v": value.__name__}
    text = repr(value)
    if len(text) > REPR_LIMIT:
        return too_large(value, len(text))
    return {"t": "repr", "type": type(value).__name__, "v": text}


class Shown(str):
    """print 或交互解释器实际显示出来的文字。写成“显示内容”作答时原样使用，不再取 repr。"""


# WWPD 约定的三个显示结果：报错、什么也不显示、显示一个函数。
ERROR = Shown("ERROR")
NOTHING = Shown("NOTHING")
FUNCTION = Shown("FUNCTION")

FUNCTION_TYPES = (types.FunctionType, types.BuiltinFunctionType, types.MethodType)


def display_text(value):
    """交互解释器对一个表达式的值显示什么：None 什么也不显示（空串），函数显示 FUNCTION，其余是 repr。"""
    if value is None:
        return ""
    if isinstance(value, FUNCTION_TYPES):
        return "FUNCTION"
    return repr(value)


def as_shown(text):
    """把一段已经是“显示内容”的文字标出来，写进 match: output 的作答位时不再取 repr。"""
    return Shown(text)


def show(value):
    """一个值在交互解释器里显示的内容，沿用 NOTHING、FUNCTION 的约定，可直接用作 match: output 的答案。"""
    return Shown(display_text(value) or "NOTHING")


def as_text(value, display=False):
    """把核对程序算出的值写成学生的作答。

    普通文字作答：字符串原样，其余用 repr（True 成为 "True"，4 成为 "4"）。
    显示内容作答（match: output）：Python 会显示什么就写什么，所以字符串也取 repr（'42' 带引号）；
    run().out、lines()、repl()、as_shown()、show() 和 ERROR、NOTHING、FUNCTION 给出的是已经显示出来的文字，原样使用。
    """
    if isinstance(value, Shown):
        return str(value)
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, str) and not display:
        return value
    return repr(value)


# ---------------------------------------------------------------------------
# 核对程序可用的工具
# ---------------------------------------------------------------------------

QUESTION_FILE = "<题面代码>"


class RunResult:
    """run() 的结果：out 为打印内容，error 为异常类型名（没有异常为 None），error_line 为它停在代码的第几行，vars 为运行后的变量。"""

    def __init__(self, out, error, namespace):
        self.out = Shown(out)
        self.error = error["type"] if error else None
        self.message = error["message"] if error else None
        self.error_line = error["line"] if error else None
        self.vars = {name: item for name, item in namespace.items() if name not in ("__name__", "__builtins__")}

    def __getitem__(self, name):
        return self.vars[name]

    def lines(self):
        return [Shown(line) for line in self.out.splitlines()]


class Call:
    """calls() 记下的一次函数调用：args 是调用时各形参收到的值，locals 是函数结束时局部变量的值，returned 是返回值。"""

    def __init__(self, args):
        self.args = args
        self.locals = {}
        self.returned = None

    def __getitem__(self, name):
        return self.args[name]


def snapshot(value):
    try:
        return copy.deepcopy(value)
    except Exception:  # noqa: BLE001  不能复制的对象按原样记录
        return value


def statements(code):
    return ast.parse(code).body


def parameter_names(code_object):
    count = code_object.co_argcount + code_object.co_kwonlyargcount
    count += bool(code_object.co_flags & inspect.CO_VARARGS) + bool(code_object.co_flags & inspect.CO_VARKEYWORDS)
    return code_object.co_varnames[:count]


def make_helpers(data, question_code, prelude):
    def fresh(inputs):
        namespace = build_namespace(data, prelude)
        namespace.update(inputs)
        return namespace

    def run(code=None, **inputs):
        """在全新的命名空间里运行代码（缺省为题面代码 CODE），返回 RunResult。inputs 是事先赋好的变量。"""
        namespace = fresh(inputs)
        out, error = run_quietly(question_code if code is None else code, namespace, QUESTION_FILE)
        return RunResult(out, error, namespace)

    def run_traced(code, inputs, trace):
        namespace = fresh(inputs)
        sys.settrace(trace)
        try:
            run_quietly(question_code if code is None else code, namespace, QUESTION_FILE)
        finally:
            sys.settrace(None)

    def executed_lines(code=None, **inputs):
        """运行代码，返回实际执行过的行号（升序，含函数体里的行）。def、else: 这类本身没有字节码的行不会出现。"""
        lines = set()

        def local(frame, event, arg):
            if event == "line":
                lines.add(frame.f_lineno)
            return local

        run_traced(code, inputs, lambda frame, event, arg: local if frame.f_code.co_filename == QUESTION_FILE else None)
        return sorted(lines)

    def calls(code=None, name=None, **inputs):
        """运行代码，按调用的先后返回名为 name 的函数每次被调用的 Call 列表（args、locals、returned）。"""
        if name is None:
            raise TypeError("calls() 需要 name：要记录哪个函数的调用")
        records = []

        def on_call(frame, event, arg):
            if frame.f_code.co_filename != QUESTION_FILE or frame.f_code.co_name != name:
                return None
            names = parameter_names(frame.f_code)
            record = Call({key: snapshot(frame.f_locals[key]) for key in names if key in frame.f_locals})
            records.append(record)

            def local(frame, event, arg):
                if event == "return":
                    record.returned = snapshot(arg)
                    record.locals = {key: snapshot(item) for key, item in frame.f_locals.items()}
                return local

            return local

        run_traced(code, inputs, on_call)
        return records

    def trace(code=None, names=(), **inputs):
        """逐条运行顶层语句，返回每条语句执行后 names 中已定义变量的值。"""
        namespace = fresh(inputs)
        states = []
        with contextlib.redirect_stdout(LimitedOutput()):
            for node in statements(question_code if code is None else code):
                exec(compile(ast.Module(body=[node], type_ignores=[]), QUESTION_FILE, "exec"), namespace)
                states.append({name: snapshot(namespace[name]) for name in names if name in namespace})
        return states

    def repl(code=None, **inputs):
        """像交互解释器那样逐条输入顶层语句，返回每条的显示内容；沿用 61A 的 NOTHING、ERROR、FUNCTION 约定。"""
        namespace = fresh(inputs)
        results = []
        for node in statements(question_code if code is None else code):
            output = LimitedOutput()

            def display(value):
                text = display_text(value)
                if text:
                    output.write(text + "\n")

            previous = sys.displayhook
            sys.displayhook = display
            try:
                with contextlib.redirect_stdout(output):
                    exec(compile(ast.Interactive(body=[node]), "<交互>", "single"), namespace)
                text = output.getvalue().rstrip("\n")
            except Exception:  # noqa: BLE001  报错在 WWPD 里就是一种显示结果
                text = ERROR
            finally:
                sys.displayhook = previous
            results.append(Shown(text if text else NOTHING))
        return results

    return {"run": run, "trace": trace, "repl": repl, "executed_lines": executed_lines, "calls": calls}


# ---------------------------------------------------------------------------
# 任务
# ---------------------------------------------------------------------------


def convert_answer(value, shape):
    """按作答位的形状把算出的值写成作答。

    text、display 为一段文字（display 是显示内容）；id 为一个选项 id；ids 为一组 id；
    {"kind": "table", "cells": {"行/列": "text" 或 "display"}} 为 {行: {列: 文字}}，表里没列出的格原样交回，由外面报告。
    """
    if shape in ("text", "display", "id"):
        return as_text(value, display=shape == "display")
    if shape == "ids":
        if isinstance(value, (str, bytes)) or not hasattr(value, "__iter__"):
            raise TypeError("这一小问的答案应是一组 id")
        return [as_text(item) for item in value]
    if isinstance(shape, dict) and shape.get("kind") == "table":
        cells = shape["cells"]
        rows = {}
        for row, columns in dict(value).items():
            row = as_text(row)
            rows[row] = {}
            for column, cell in dict(columns).items():
                column = as_text(column)
                rows[row][column] = as_text(cell, display=cells.get(f"{row}/{column}") == "display")
        return rows
    raise ValueError(f"不认识的作答形状 {shape}")


def job_verify(job):
    prelude = job.get("prelude", "")
    helpers = make_helpers(job["data"], job["code"], prelude)
    environment = {name: item for name, item in build_namespace(job["data"], prelude).items() if name not in ("__name__", "__builtins__")}
    environment.update({
        "__name__": "__verify__", "__builtins__": builtins, **helpers,
        "as_shown": as_shown, "show": show, "ERROR": ERROR, "NOTHING": NOTHING, "FUNCTION": FUNCTION,
        "CODE": job["code"], "BLOCKS": job["blocks"], "OPTIONS": job["options"], "CELLS": job["cells"],
    })
    with contextlib.redirect_stdout(LimitedOutput()):
        exec(compile(job["script"], "<verify>", "exec"), environment)
    answers = environment.get("answers")
    if not isinstance(answers, dict):
        raise TypeError("verify 程序结束时，需要给 answers 赋一个字典")
    converted = {}
    unknown = []
    for slot, value in answers.items():
        shape = job["shape"].get(slot)
        if shape is None:
            unknown.append(str(slot))
            continue
        converted[slot] = convert_answer(value, shape)
    return {"answers": converted, "unknown": unknown}


def prepared(job):
    namespace = build_namespace(job["data"], job.get("prelude", ""))
    run_setup(namespace, job.get("setup"))
    return namespace


def run_setup(namespace, setup):
    if setup:
        out, error = run_quietly(setup, namespace, "<setup>")
        if error:
            raise RuntimeError(f"测试的 setup 出错：{error['type']}: {error['message']}")


def job_expect(job):
    results = {}
    for expression, source in job["exprs"].items():
        namespace = prepared(job)
        try:
            with contextlib.redirect_stdout(LimitedOutput()):
                results[expression] = {"value": canon(eval(compile(source, "<expect>", "eval"), namespace))}
        except Exception as error:  # noqa: BLE001
            results[expression] = {"error": describe_error(error)}
    return results


def job_program(job):
    namespace = prepared(job)
    stdout, error = run_quietly(job["program"], namespace, "<作答>")
    captures = {}
    for expression in job["captures"]:
        try:
            with contextlib.redirect_stdout(LimitedOutput()):
                captures[expression] = {"value": canon(eval(compile(expression, "<检查>", "eval"), namespace))}
        except Exception as failure:  # noqa: BLE001
            captures[expression] = {"error": describe_error(failure)}
    examples = []
    for source in job["doctest"]:
        output = LimitedOutput()
        exception = None
        with contextlib.redirect_stdout(output):
            try:
                exec(compile(source + "\n", "<doctest>", "single"), namespace)
            except Exception as failure:  # noqa: BLE001
                exception = "".join(traceback.format_exception_only(type(failure), failure)).strip()
        examples.append({"out": output.getvalue(), "exception": exception})
    return {"stdout": stdout, "error": error, "captures": captures, "doctest": examples}


JOBS = {"verify": job_verify, "expect": job_expect, "program": job_program}


def frontend_test(line):
    """前端 python.run 的一个测试，结果与 program 任务相同，但一步一步执行。

    每个阶段开始前先产出 (阶段, 序号)，Worker 转告页面；超时时页面结束整个 Worker，
    按最后收到的阶段判断停在哪里。capture 的求值算学习者的，序列化算运行器的，所以拆成两步。
    生成器的返回值是 JSON：{"status": "done", ...program 任务的结果} 或 {"status": "failed", "phase", "error"}。
    """
    job = json.loads(line)
    phase = "prelude"
    try:
        yield phase, None
        namespace = new_namespace(job.get("prelude", ""))
        phase = "data"
        yield phase, None
        load_data(namespace, job["data"])
        phase = "setup"
        yield phase, None
        run_setup(namespace, job.get("setup"))
        phase = "program"
        yield phase, None
        stdout, error = run_quietly(job["program"], namespace, "<作答>")
        captures = {}
        for index, expression in enumerate(job["captures"]):
            phase = "captures"
            yield phase, index
            try:
                with contextlib.redirect_stdout(LimitedOutput()):
                    value = eval(compile(expression, "<检查>", "eval"), namespace)
            except BaseException as failure:  # noqa: BLE001  被检查的调用是学习者的代码，可能 exit()
                captures[expression] = {"error": describe_error(failure)}
                continue
            phase = "serialize"
            yield phase, index
            try:
                with contextlib.redirect_stdout(LimitedOutput()):
                    captures[expression] = {"value": canon(value)}
            except Exception as failure:  # noqa: BLE001  与 program 任务相同，记在这个 capture 上
                captures[expression] = {"error": describe_error(failure)}
        examples = []
        for index, source in enumerate(job["doctest"]):
            phase = "doctest"
            yield phase, index
            output = LimitedOutput()
            exception = None
            with contextlib.redirect_stdout(output):
                try:
                    exec(compile(source + "\n", "<doctest>", "single"), namespace)
                except BaseException as failure:  # noqa: BLE001
                    exception = "".join(traceback.format_exception_only(type(failure), failure)).strip()
            examples.append({"out": output.getvalue(), "exception": exception})
        result = {"status": "done", "stdout": stdout, "error": error, "captures": captures, "doctest": examples}
    except Exception as failure:  # noqa: BLE001  学习者代码的异常已在各阶段记下；到这里的是前导、数据或 setup 出错
        result = {"status": "failed", "phase": phase, "error": describe_error(failure)}
    yield "teardown", None
    reset_state()
    return json.dumps(result, ensure_ascii=False)


def handle_job(line):
    job = json.loads(line)
    try:
        reply = json.dumps({"ok": True, "result": JOBS[job["op"]](job)}, ensure_ascii=False)
    except BaseException as error:  # noqa: BLE001  任务失败不应结束整个运行器
        reply = json.dumps({"ok": False, "error": describe_error(error), "trace": traceback.format_exc()[-4000:]}, ensure_ascii=False)
    reset_state()
    return reply


def runtime_versions(packages):
    return json.dumps({
        "python": sys.version.split()[0],
        "packages": {name: importlib.metadata.version(name) for name in packages},
    })
