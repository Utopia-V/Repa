"""在 Landlock 与 seccomp 限制下启动课程检查用的 Node 进程。

由 src/sandbox/session.ts 以 `python3 -I -S launch.py <配置 JSON>` 调用。本程序只做限制，然后 execve 成 Node，
自身不再运行；限制随 execve 一直保留到进程结束，也无法再放宽。

为什么不用 bwrap：Ubuntu 23.10 起默认开启 kernel.apparmor_restrict_unprivileged_userns，
没有专用 AppArmor 配置时非特权进程写不了 uid_map，bwrap 无法建立 namespace。Landlock 和 seccomp
不需要 namespace，普通用户就能使用。

限制的内容：
- 文件：只能读配置里列出的路径；只能执行 Node 本身和它的动态链接器；只有 /dev/null 可写。
- 网络：seccomp 拒绝创建任何 socket；Landlock 再拒绝 TCP 绑定和连接。
- 进程：seccomp 只允许创建线程（clone 带 CLONE_THREAD），fork、vfork 与 clone3 都被拒绝，
  所以沙箱里始终只有这一个进程，RLIMIT_DATA 就是整个沙箱的私有内存上限。
- 其他进程：seccomp 只允许向自己发信号，拒绝对别的进程调整资源上限、优先级、调度和 I/O 优先级
  （Landlock ABI 6 起另有信号作用域，更早的内核靠这一条）；拒绝 io_uring、ptrace、bpf、挂载和 namespace
  相关调用。
任何一步失败都以退出码 70 结束并说明原因，不会降级成不受限的运行。
"""

import ctypes
import json
import os
import resource
import sys

UNAVAILABLE = 70


def fail(message):
    sys.stderr.write(f"repa-sandbox: {message}\n")
    sys.exit(UNAVAILABLE)


libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
libc.prctl.restype = ctypes.c_int


def checked(result, action):
    if result < 0:
        fail(f"{action}失败：{os.strerror(ctypes.get_errno())}")
    return result


# ---------------------------------------------------------------------------
# Landlock（include/uapi/linux/landlock.h）
# ---------------------------------------------------------------------------

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1

FS_EXECUTE = 1 << 0
FS_WRITE_FILE = 1 << 1
FS_READ_FILE = 1 << 2
FS_READ_DIR = 1 << 3
FS_REFER = 1 << 13  # ABI 2
FS_TRUNCATE = 1 << 14  # ABI 3
FS_IOCTL_DEV = 1 << 15  # ABI 5
FILE_RIGHTS = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV
NET_BIND_TCP = 1 << 0  # ABI 4
NET_CONNECT_TCP = 1 << 1
SCOPE_ABSTRACT_UNIX_SOCKET = 1 << 0  # ABI 6
SCOPE_SIGNAL = 1 << 1

# ABI 4 起才能限制 TCP；更早的内核也缺少 truncate 等文件权限的控制，直接拒绝运行。
MINIMUM_ABI = 4


class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64), ("handled_access_net", ctypes.c_uint64), ("scoped", ctypes.c_uint64)]


class PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def landlock(read_paths, execute_paths, write_paths):
    abi = libc.syscall(SYS_LANDLOCK_CREATE_RULESET, None, ctypes.c_size_t(0), ctypes.c_uint32(LANDLOCK_CREATE_RULESET_VERSION))
    if abi < 0:
        fail(f"内核没有可用的 Landlock：{os.strerror(ctypes.get_errno())}")
    if abi < MINIMUM_ABI:
        fail(f"Landlock ABI 为 {abi}，至少需要 {MINIMUM_ABI}（Linux 6.7 以上）")
    handled_fs = (1 << 13) - 1 | FS_REFER | FS_TRUNCATE
    if abi >= 5:
        handled_fs |= FS_IOCTL_DEV
    attr = RulesetAttr(handled_fs, NET_BIND_TCP | NET_CONNECT_TCP, SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL if abi >= 6 else 0)
    size = ctypes.sizeof(RulesetAttr) if abi >= 6 else 16
    ruleset = checked(libc.syscall(SYS_LANDLOCK_CREATE_RULESET, ctypes.byref(attr), ctypes.c_size_t(size), ctypes.c_uint32(0)), "建立 Landlock 规则集")

    def allow(path, rights):
        try:
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except OSError as error:
            fail(f"无法打开允许访问的路径 {path}：{error.strerror}")
        if not os.path.isdir(path):
            rights &= FILE_RIGHTS
        rule = PathBeneathAttr(rights & handled_fs, fd)
        checked(libc.syscall(SYS_LANDLOCK_ADD_RULE, ruleset, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(rule), 0), f"允许访问 {path} ")
        os.close(fd)

    for path in read_paths:
        allow(path, FS_READ_FILE | FS_READ_DIR)
    for path in execute_paths:
        allow(path, FS_READ_FILE | FS_EXECUTE)
    for path in write_paths:
        allow(path, FS_READ_FILE | FS_WRITE_FILE)
    checked(libc.syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset, 0), "启用 Landlock ")
    os.close(ruleset)


# ---------------------------------------------------------------------------
# seccomp（libseccomp）
# ---------------------------------------------------------------------------

SCMP_ACT_ALLOW = 0x7FFF0000
SCMP_CMP_NE = 1
SCMP_CMP_MASKED_EQ = 7
CLONE_THREAD = 0x00010000
EPERM, EACCES, ENOSYS = 1, 13, 38


def errno_action(code):
    return 0x00050000 | (code & 0xFFFF)


class ArgCmp(ctypes.Structure):
    _fields_ = [("arg", ctypes.c_uint), ("op", ctypes.c_int), ("datum_a", ctypes.c_uint64), ("datum_b", ctypes.c_uint64)]


DENIED = {
    # 网络：不建任何 socket。
    "socket": EACCES,
    # io_uring 能绕过 seccomp 发起 socket 等操作；返回 ENOSYS，libuv 会退回普通实现。
    "io_uring_setup": ENOSYS, "io_uring_enter": ENOSYS, "io_uring_register": ENOSYS,
    # 进程：glibc 收到 ENOSYS 后改用 clone，clone 再按 CLONE_THREAD 过滤。
    "clone3": ENOSYS, "fork": EPERM, "vfork": EPERM,
    # 观察和改写其他进程、内核接口、挂载与 namespace。
    "ptrace": EPERM, "process_vm_readv": EPERM, "process_vm_writev": EPERM,
    "bpf": EPERM, "perf_event_open": EPERM, "userfaultfd": EPERM,
    "keyctl": EPERM, "add_key": EPERM, "request_key": EPERM,
    "mount": EPERM, "umount2": EPERM, "pivot_root": EPERM, "chroot": EPERM,
    "unshare": EPERM, "setns": EPERM, "open_by_handle_at": EPERM, "name_to_handle_at": EPERM,
    "fsopen": EPERM, "fsconfig": EPERM, "fsmount": EPERM, "fspick": EPERM,
    "move_mount": EPERM, "open_tree": EPERM, "mount_setattr": EPERM,
    # 影响别的进程：只按线程号发信号、经 pidfd 操作别的进程、调整优先级。
    "tkill": EPERM, "pidfd_open": EPERM, "pidfd_send_signal": EPERM, "pidfd_getfd": EPERM,
    "process_madvise": EPERM, "setpriority": EPERM, "ioprio_set": EPERM,
}

# 第一个参数是进程号的调用：信号只能发给自己；资源上限和调度只能改自己（0 表示调用者）。
OWN_PROCESS_ONLY = ("kill", "tgkill", "rt_sigqueueinfo", "rt_tgsigqueueinfo")
CALLER_ONLY = ("prlimit64", "sched_setaffinity", "sched_setscheduler", "sched_setparam", "sched_setattr")


def seccomp_filter():
    try:
        seccomp = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    except OSError:
        fail("找不到 libseccomp.so.2")
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    context = seccomp.seccomp_init(SCMP_ACT_ALLOW)
    if not context:
        fail("seccomp 初始化失败")
    for name, code in DENIED.items():
        number = seccomp.seccomp_syscall_resolve_name(name.encode())
        if number < 0:
            continue  # 这个架构或 libseccomp 版本不认识的调用，本来也无法使用。
        if seccomp.seccomp_rule_add(context, errno_action(code), number, 0) < 0:
            fail(f"seccomp 无法拒绝 {name}")
    def deny_when(name, comparison):
        number = seccomp.seccomp_syscall_resolve_name(name.encode())
        if number < 0:
            return
        if seccomp.seccomp_rule_add_array(context, errno_action(EPERM), number, 1, ctypes.byref(comparison)) < 0:
            fail(f"seccomp 无法过滤 {name}")

    deny_when("clone", ArgCmp(0, SCMP_CMP_MASKED_EQ, CLONE_THREAD, 0))
    # execve 之后进程号不变，所以这里取到的就是之后 Node 的进程号。
    own = os.getpid()
    for name in OWN_PROCESS_ONLY:
        deny_when(name, ArgCmp(0, SCMP_CMP_NE, own, 0))
    for name in CALLER_ONLY:
        deny_when(name, ArgCmp(0, SCMP_CMP_NE, 0, 0))

    def load():
        if seccomp.seccomp_load(context) < 0:
            fail("seccomp 加载失败")
        seccomp.seccomp_release(context)

    return load


def elf_interpreter(executable):
    """读出 ELF 可执行文件的 PT_INTERP，也就是需要放行执行的动态链接器。"""
    with open(executable, "rb") as handle:
        header = handle.read(64)
        if header[:4] != b"\x7fELF" or header[4] != 2 or header[5] != 1:
            fail(f"{executable} 不是 64 位小端 ELF 可执行文件")
        phoff = int.from_bytes(header[32:40], "little")
        phentsize = int.from_bytes(header[54:56], "little")
        phnum = int.from_bytes(header[56:58], "little")
        for index in range(phnum):
            handle.seek(phoff + index * phentsize)
            entry = handle.read(phentsize)
            if int.from_bytes(entry[0:4], "little") == 3:  # PT_INTERP
                handle.seek(int.from_bytes(entry[8:16], "little"))
                return handle.read(int.from_bytes(entry[32:40], "little")).rstrip(b"\0").decode()
    return None


def main():
    config = json.loads(sys.argv[1])
    executable = os.path.realpath(config["argv"][0])
    interpreter = elf_interpreter(executable)
    execute_paths = [executable] + ([os.path.realpath(interpreter)] if interpreter else [])
    load_seccomp = seccomp_filter()

    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_DATA, (config["memory"], config["memory"]))
    resource.setrlimit(resource.RLIMIT_CPU, (config["cpuSeconds"], config["cpuSeconds"]))

    parent = os.getppid()
    checked(libc.prctl(1, 9, 0, 0, 0), "设置父进程退出信号")  # PR_SET_PDEATHSIG, SIGKILL
    if os.getppid() != parent:
        fail("父进程已经退出")
    checked(libc.prctl(38, 1, 0, 0, 0), "设置 no_new_privs ")  # PR_SET_NO_NEW_PRIVS
    landlock(config["read"], execute_paths, config["write"])
    load_seccomp()
    os.closerange(3, 65536)
    os.execve(executable, config["argv"], config["env"])


main()
