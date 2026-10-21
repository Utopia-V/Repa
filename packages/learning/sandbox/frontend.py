"""前端 python.run 的一个测试，在 runner.py 之后加载到同一个全局命名空间。

结果与 runner.py 的 program 任务相同，但一步一步执行：每个阶段开始前先产出 (阶段, 序号)，
Worker 转告页面；超时时页面结束整个 Worker，按最后收到的阶段判断停在哪里。
capture 的求值算学习者的，序列化算运行器的，所以拆成 capture 和 serialize 两步。
这部分不放进 runner.py：runner.py 的内容摘要绑定着课程核对算出的期望值，前端的调度改动不应让它们失效。
"""


def frontend_test(line):
    """生成器的返回值是 JSON：{"status": "completed", "result": program 任务的结果}，或前导、夹具、setup 出错时的
    {"status": "failed", "phase": "prepare", "error"}。"""
    job = json.loads(line)
    try:
        yield "prepare", None
        data = [{**item["fixture"], "label": item["label"]} for item in job["data"]]
        namespace = prepared({"data": data, "prelude": job["prelude"], "setup": job["setup"]})
        yield "program", None
        stdout, error = run_quietly(job["program"], namespace, "<作答>")
        captures = {}
        for index, expression in enumerate(job["captures"]):
            yield "capture", index
            try:
                with contextlib.redirect_stdout(LimitedOutput()):
                    value = eval(compile(expression, "<检查>", "eval"), namespace)
            except BaseException as failure:  # noqa: BLE001  被检查的调用是学习者的代码，可能 exit()
                captures[expression] = {"error": describe_error(failure)}
                continue
            yield "serialize", index
            try:
                with contextlib.redirect_stdout(LimitedOutput()):
                    captures[expression] = {"value": canon(value)}
            except Exception as failure:  # noqa: BLE001  与 program 任务相同，记在这个 capture 上
                captures[expression] = {"error": describe_error(failure)}
        examples = []
        for index, source in enumerate(job["doctest"]):
            yield "doctest", index
            output = LimitedOutput()
            exception = None
            with contextlib.redirect_stdout(output):
                try:
                    exec(compile(source + "\n", "<doctest>", "single"), namespace)
                except BaseException as failure:  # noqa: BLE001
                    exception = "".join(traceback.format_exception_only(type(failure), failure)).strip()
            examples.append({"out": output.getvalue(), "exception": exception})
        result = {
            "status": "completed",
            "result": {"stdout": stdout, "error": error, "captures": captures, "doctest": examples},
        }
    except Exception as failure:  # noqa: BLE001  学习者代码的异常已在各阶段记下；到这里的是前导、夹具或 setup 出错
        result = {"status": "failed", "phase": "prepare", "error": describe_error(failure)}
    yield "cleanup", None
    reset_state()
    return json.dumps(result, ensure_ascii=False)
