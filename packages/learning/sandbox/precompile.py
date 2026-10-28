# 在 Pyodide 里给标准库 zip 和 wheel 加上 .pyc，供课程核对的沙箱跳过编译源码。
# 由 src/sandbox/precompile.ts 调用；用同一个 Pyodide 编译，magic number 和字节码与沙箱里的解释器一致。
# .py 保留，dfile 写运行时的绝对路径，traceback、源码行和 __file__ 都与不预编译时相同。
# unchecked hash 模式不比对时间戳或源码，产物只由输入决定；zip 条目时间沿用对应的 .py 条目，产物逐字节可复现。
import importlib.util
import py_compile
import sys
import sysconfig
import zipfile

UNCHECKED = py_compile.PycInvalidationMode.UNCHECKED_HASH
STDLIB = next(entry for entry in sys.path if entry.endswith(".zip"))
SITE = sysconfig.get_paths()["purelib"]


def compiled(source, dfile):
    with open("/tmp/precompile.py", "wb") as handle:
        handle.write(source)
    py_compile.compile("/tmp/precompile.py", cfile="/tmp/precompile.pyc", dfile=dfile, doraise=True, invalidation_mode=UNCHECKED)
    with open("/tmp/precompile.pyc", "rb") as handle:
        return handle.read()


def rebuild(source, target, pyc_name, dfile_of):
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for info in original.infolist():
            data = original.read(info)
            output.writestr(info, data)
            if info.filename.endswith(".py"):
                entry = zipfile.ZipInfo(pyc_name(info.filename), date_time=info.date_time)
                entry.compress_type = zipfile.ZIP_DEFLATED
                output.writestr(entry, compiled(data, dfile_of(info.filename)))


def precompile_stdlib(source, target):
    # zipimport 在同一目录先找 name.pyc，不看 __pycache__。
    rebuild(source, target, lambda name: name + "c", lambda name: f"{STDLIB}/{name}")


def precompile_wheel(source, target):
    # wheel 解压进 site-packages，导入时按 cache_from_source 的位置找 .pyc。
    rebuild(source, target, importlib.util.cache_from_source, lambda name: f"{SITE}/{name}")
