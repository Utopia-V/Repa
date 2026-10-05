import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Duplex, Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runCommand, type CommandResult } from "../src/execution/process.js";
import type { ExecutionPolicy } from "../src/execution/schema.js";
import { prepareCommand } from "../src/execution/sandbox.js";

const linux = process.platform === "linux";
const helperAvailable = existsSync(new URL("../resources/sandbox/linux-x64/codex-linux-sandbox", import.meta.url));
const restrictedSkip = !linux ? "需要 Linux" : !helperAvailable ? "需要先构建固定 Linux helper" : false;
const restricted: ExecutionPolicy = { mode: "restricted", readPaths: [], writePaths: [], network: false };
const fullAccess: ExecutionPolicy = { mode: "full-access" };

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "repa-execution-test-")));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const home = path.join(root, "home");
  const temporary = path.join(root, "tmp");
  const protectedPath = path.join(cwd, ".repa");
  await mkdir(protectedPath, { recursive: true });
  await mkdir(outside);
  await mkdir(home);
  await mkdir(temporary);
  const env: NodeJS.ProcessEnv = {
    HOME: home, TMPDIR: temporary, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8",
  };
  await writeFile(path.join(protectedPath, "secret.txt"), "protected\n");
  await writeFile(path.join(outside, "secret.txt"), "outside\n");
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const execute = async (command: string, policy: ExecutionPolicy = restricted) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const result = await runCommand({
      command, cwd, policy, protectedPaths: [protectedPath], env,
      onData(stream, bytes) { (stream === "stdout" ? stdout : stderr).push(bytes); },
    });
    return { ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  };
  return { root, cwd, outside, home, temporary, protectedPath, env, execute };
}

async function processState(pid: number): Promise<{ state: string; parent: number; name: string; group: number } | undefined> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
    const state = fields[0];
    assert(state);
    return { state, parent: Number(fields[1]), group: Number(fields[2]), name: value.slice(value.indexOf("(") + 1, value.lastIndexOf(")")) };
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) {
      return undefined;
    }
    throw error;
  }
}

async function descendants(parent: number): Promise<number[]> {
  const entries = await Promise.all((await readdir("/proc")).filter((value) => /^\d+$/.test(value)).map(async (value) => ({
    pid: Number(value), info: await processState(Number(value)),
  })));
  const result = new Set([parent]);
  let size: number;
  do {
    size = result.size;
    for (const entry of entries) {
      if (entry.info && result.has(entry.info.parent)) {
        result.add(entry.pid);
      }
    }
  } while (result.size !== size);
  return [...result];
}

async function directChildren(pid: number): Promise<number[]> {
  try {
    const value = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
    return value.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) {
      return [];
    }
    throw error;
  }
}

async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, description);
    await delay(10);
  }
}

async function assertExited(pids: readonly number[]) {
  for (const pid of pids) {
    const info = await processState(pid);
    assert(!info || info.state === "Z" || info.state === "X", `进程 ${pid} 仍活动：${JSON.stringify(info)}`);
  }
}

for (const policy of [restricted, fullAccess]) {
  const skip = policy.mode === "restricted" ? restrictedSkip : !linux;
  test(`${policy.mode} 在工作目录真实编译运行 C 程序并区分输出流`, { skip }, async (t) => {
    const f = await fixture(t);
    await writeFile(path.join(f.cwd, "main.c"), '#include <stdio.h>\nint main(void) { puts("练习完成"); fputs("diagnostic\\n", stderr); return 7; }\n');
    const result = await f.execute("cc main.c -o exercise && ./exercise", policy);
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, "练习完成\n");
    assert.equal(result.stderr, "diagnostic\n");
  });

  test(`${policy.mode} 并行取消一条命令时回收其父子进程而不终止另一条`, { skip }, async (t) => {
    const f = await fixture(t);
    const controller = new AbortController();
    let output = "";
    let pid = 0;
    const events: string[] = [];
    let terminal: CommandResult | undefined;
    const running = runCommand({
      command: 'sleep 60 & printf "ready\\n"; wait', cwd: f.cwd, policy, protectedPaths: [f.protectedPath], env: f.env, signal: controller.signal,
      onData(_stream, bytes) { output += bytes.toString("utf8"); },
      onStarted(value) { pid = value; },
      onExited(value) { terminal = value; events.push("exited"); },
    });
    const rejected = assert.rejects(running, (error: unknown) => {
      events.push("rejected");
      return error instanceof Error && error.message === "aborted";
    });
    t.after(async () => { controller.abort(); await rejected; });
    const independent = f.execute("sleep 0.4; printf 'independent\\n'", policy);
    await until(() => output.includes("ready\n") && pid > 0, "命令未进入等待状态");
    const pids = await descendants(pid);
    assert(pids.length >= 2, `未观察到子进程：${JSON.stringify(pids)}`);
    controller.abort();
    await rejected;
    assert(terminal);
    assert(terminal.exitCode >= 128);
    assert.deepEqual(events, ["exited", "rejected"]);
    await assertExited(pids);
    const second = await independent;
    assert.equal(second.exitCode, 0);
    assert.equal(second.stdout, "independent\n");
  });

  test(`${policy.mode} 超时等待实际退出后报告终态再抛出 SDK 超时错误`, { skip }, async (t) => {
    const f = await fixture(t);
    let terminal: CommandResult | undefined;
    let pid = 0;
    await assert.rejects(runCommand({
      command: "sleep 60", cwd: f.cwd, policy, protectedPaths: [], env: f.env, timeout: 0.1,
      onData() {}, onStarted(value) { pid = value; }, onExited(value) { terminal = value; },
    }), { message: "timeout:0.1" });
    assert(terminal);
    assert(terminal.exitCode >= 128);
    await assertExited([pid]);
  });

  test(`${policy.mode} 普通父命令结束后也终止遗留的后台子进程`, { skip }, async (t) => {
    const f = await fixture(t);
    const heartbeat = path.join(f.cwd, "heartbeat");
    const result = await f.execute(`(while :; do printf 'x' >> ${quote(heartbeat)}; sleep 0.05; done) & sleep 0.2; printf 'done\\n'`, policy);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "done\n");
    const before = await readFile(heartbeat, "utf8");
    assert(before.length > 0);
    await delay(150);
    assert.equal(await readFile(heartbeat, "utf8"), before);
  });

  test(`${policy.mode} 输出消费者失败时停止命令，先回收进程再传播原错误`, { skip }, async (t) => {
    const f = await fixture(t);
    const failure = new Error("output-consumer-failed");
    let pid = 0;
    let terminal: CommandResult | undefined;
    await assert.rejects(runCommand({
      command: "printf 'output'; sleep 60", cwd: f.cwd, policy, protectedPaths: [], env: f.env,
      onData() { throw failure; }, onStarted(value) { pid = value; }, onExited(value) { terminal = value; },
    }), (error: unknown) => error === failure);
    assert(terminal);
    await assertExited([pid]);
  });
}

test("受限命令隔离宿主环境并回收自己的临时目录", { skip: restrictedSkip }, async (t) => {
  const f = await fixture(t);
  for (const name of ["OPENAI_API_KEY", "BASH_ENV", "LD_PRELOAD", "HTTP_PROXY"]) {
    f.env[name] = "should-not-inherit";
  }
  const result = await f.execute('printf "%s\\n" "$HOME" "$TMPDIR"; env');
  assert.equal(result.exitCode, 0);
  assert(!result.stdout.includes("should-not-inherit"));
  const [home, temporary] = result.stdout.split("\n");
  assert(home && temporary);
  assert.notEqual(home, f.home);
  assert.equal(path.dirname(home), path.dirname(temporary));
  await assert.rejects(readFile(home), { code: "ENOENT" });
  await assert.rejects(readFile(temporary), { code: "ENOENT" });
});

test("Full Access 使用用户工具的 PATH、配置和登录环境，保留代理与工具凭据", { skip: !linux }, async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.home, "bin");
  await mkdir(bin);
  await mkdir(path.join(f.home, ".config"));
  await writeFile(path.join(f.home, ".config", "tool.conf"), "configured\n");
  await writeFile(path.join(f.home, ".bash_profile"), "export REPA_TEST_PROFILE=loaded\n");
  const tool = path.join(bin, "node");
  await writeFile(tool, '#!/bin/sh\ncat "$HOME/.config/tool.conf"\nprintf "%s\\n" "$HOME" "$TMPDIR" "$REPA_TEST_PROFILE" "$HTTPS_PROXY" "$TOOL_API_KEY"\npwd\n');
  await chmod(tool, 0o755);
  f.env.PATH = `${bin}:${f.env.PATH}`;
  f.env.HTTPS_PROXY = "http://proxy.example.invalid:8080";
  f.env.TOOL_API_KEY = "fixture-tool-key";

  const result = await f.execute("node", fullAccess);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, [
    "configured", f.home, f.temporary, "loaded", f.env.HTTPS_PROXY, f.env.TOOL_API_KEY, f.cwd, "",
  ].join("\n"));
  assert.equal(await readFile(path.join(f.home, ".config", "tool.conf"), "utf8"), "configured\n");
  assert(existsSync(f.temporary));
});

test("Full Access 超时后对忽略 TERM 的父子进程升级 KILL 并返回真实 signal 退出码", { skip: !linux }, async (t) => {
  const f = await fixture(t);
  let terminal: CommandResult | undefined;
  let pid = 0;
  await assert.rejects(runCommand({
    command: "trap '' TERM; sleep 60", cwd: f.cwd, policy: fullAccess, protectedPaths: [], env: f.env, timeout: 0.1,
    onData() {}, onStarted(value) { pid = value; }, onExited(value) { terminal = value; },
  }), { message: "timeout:0.1" });
  assert.deepEqual(terminal, { exitCode: 137, signal: "SIGKILL" });
  await assertExited([pid]);
});

test("受限沙箱启动时父进程退出，未放行的命令不执行且整个 PID namespace 随之退出", { skip: restrictedSkip, timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.cwd, "must-not-run");
  const executable = new URL("../resources/sandbox/linux-x64/codex-resources/bwrap", import.meta.url);
  const child = spawn(fileURLToPath(executable), [
    "--as-pid-1", "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid",
    "--bind", "/", "/", "--block-fd", "3", "--info-fd", "4", "--",
    "/bin/bash", "--noprofile", "--norc", "-c", `printf unexpected > ${quote(marker)}; sleep 30`,
  ], { cwd: f.cwd, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
  const barrier = child.stdio[3];
  const information = child.stdio[4];
  assert(barrier instanceof Duplex);
  assert(information instanceof Readable);
  let namespacePid = 0;
  let closed = false;
  const done = new Promise<void>((resolve) => {
    child.on("close", () => { closed = true; resolve(); });
  });
  t.after(async () => {
    if (!closed && namespacePid > 0) {
      try { process.kill(namespacePid, "SIGKILL"); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
      }
    }
    child.kill("SIGKILL");
    barrier.end();
    await done;
  });
  const namespace = new Promise<number>((resolve, reject) => {
    let output = "";
    information.on("data", (bytes: Buffer) => { output += bytes.toString("utf8"); });
    information.on("end", () => {
      try {
        const value: unknown = JSON.parse(output);
        assert(value !== null && typeof value === "object" && "child-pid" in value);
        assert(typeof value["child-pid"] === "number" && Number.isSafeInteger(value["child-pid"]) && value["child-pid"] > 0);
        resolve(value["child-pid"]);
      } catch (error) { reject(error); }
    });
    information.on("error", reject);
    child.on("error", reject);
  });
  // bwrap 的真实 info/block FD 建立启动边界，不借助 sleep 或替换 namespace 实现。
  namespacePid = await namespace;
  assert(!existsSync(marker));
  const exited = new Promise<void>((resolve) => { child.on("exit", () => { resolve(); }); });
  // 不可捕捉的父进程死亡仍须经 PDEATHSIG 阻止启动并结束 namespace。
  assert(child.kill("SIGKILL"));
  await exited;
  barrier.end();
  await done;
  await assertExited([namespacePid]);
  assert(!existsSync(marker));
});

test("受限沙箱收到普通终止信号后等待命名空间父子进程退出", { skip: restrictedSkip, timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const executable = new URL("../resources/sandbox/linux-x64/codex-resources/bwrap", import.meta.url);
  const child = spawn(fileURLToPath(executable), [
    "--as-pid-1", "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid",
    "--bind", "/", "/", "--info-fd", "3", "--",
    "/bin/bash", "--noprofile", "--norc", "-c", 'sleep 60 & printf "ready\\n"; wait',
  ], { cwd: f.cwd, env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const information = child.stdio[3];
  const stdout = child.stdout;
  assert(information instanceof Readable);
  assert(stdout instanceof Readable);
  let namespacePid = 0;
  let closed = false;
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("close", (code, signal) => { closed = true; resolve({ code, signal }); });
    child.on("error", reject);
  });
  t.after(async () => {
    if (!closed) {
      child.kill("SIGKILL");
      if (namespacePid > 0) {
        try { process.kill(namespacePid, "SIGKILL"); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
        }
      }
    }
    await done;
  });
  const namespace = new Promise<number>((resolve, reject) => {
    let output = "";
    information.on("data", (bytes: Buffer) => { output += bytes.toString("utf8"); });
    information.on("end", () => {
      try {
        const value: unknown = JSON.parse(output);
        assert(value !== null && typeof value === "object" && "child-pid" in value);
        assert(typeof value["child-pid"] === "number" && Number.isSafeInteger(value["child-pid"]) && value["child-pid"] > 0);
        resolve(value["child-pid"]);
      } catch (error) { reject(error); }
    });
    information.on("error", reject);
  });
  const ready = new Promise<void>((resolve, reject) => {
    let output = "";
    stdout.on("data", (bytes: Buffer) => {
      output += bytes.toString("utf8");
      if (output.includes("ready\n")) resolve();
    });
    stdout.on("error", reject);
  });
  namespacePid = await namespace;
  await ready;
  const children = await directChildren(namespacePid);
  assert(children.length > 0, "未观察到命名空间内的子进程");
  assert(child.kill("SIGTERM"));
  assert.deepEqual(await done, { code: 137, signal: null });
  await assertExited([namespacePid, ...children]);
});

test("受限命令默认无法读取宿主临时目录、受保护状态或越界写入，Full Access 才移除文件隔离", { skip: restrictedSkip }, async (t) => {
  const f = await fixture(t);
  const script = [
    `cat ${quote(path.join(f.outside, "secret.txt"))}`,
    `printf denied > ${quote(path.join(f.outside, "created.txt"))}`,
    `cat ${quote(path.join(f.protectedPath, "secret.txt"))}`,
    `printf denied > ${quote(path.join(f.protectedPath, "created.txt"))}`,
  ].map((command) => `${command} && printf unexpected || printf blocked`).join("; ");
  const denied = await f.execute(script);
  assert.equal(denied.exitCode, 0);
  assert.equal(denied.stdout, "blockedblockedblockedblocked");
  await assert.rejects(readFile(path.join(f.outside, "created.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(f.protectedPath, "created.txt")), { code: "ENOENT" });
  const granted = await f.execute(script, fullAccess);
  assert.equal(granted.exitCode, 0);
  assert(granted.stdout.includes("outside\n"));
  assert(granted.stdout.includes("protected\n"));
  assert(!granted.stdout.includes("blocked"));
});

test("广泛路径授权和指向状态目录的符号链接不能重开 protectedPaths", { skip: restrictedSkip }, async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, "state-alias");
  await symlink(f.protectedPath, alias);
  const result = await f.execute(`cat ${quote(path.join(alias, "secret.txt"))}; cat ${quote(path.join(f.protectedPath, "secret.txt"))}`, {
    mode: "restricted", readPaths: [f.root, alias, path.join(f.protectedPath, "secret.txt")], writePaths: [f.root, f.protectedPath], network: false,
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.equal(await readFile(path.join(f.protectedPath, "secret.txt"), "utf8"), "protected\n");
});

test("受限命令可使用显式读取授权中的工具目录", { skip: restrictedSkip }, async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.outside, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "lesson-tool"), "#!/bin/bash\nprintf 'toolchain\\n'\n");
  await chmod(path.join(bin, "lesson-tool"), 0o755);
  const result = await f.execute("lesson-tool", { mode: "restricted", readPaths: [f.outside], writePaths: [], network: false });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "toolchain\n");
});

test("受限空间可初始化并提交 Git 内容，状态目录仍受保护且不预造 metadata", { skip: restrictedSkip }, async (t) => {
  const f = await fixture(t);
  const before = await readdir(f.cwd);
  assert.equal((await f.execute("true")).exitCode, 0);
  assert.deepEqual(await readdir(f.cwd), before);
  const initial = await f.execute([
    "git init -q",
    "printf 'first\\n' > lesson.txt",
    "git add lesson.txt",
    "git -c user.name=Repa -c user.email=repa@example.invalid commit -qm first",
    "git log -1 --format=%s",
  ].join(" && "));
  assert.equal(initial.exitCode, 0, initial.stderr);
  assert.equal(initial.stdout, "first\n");
  const existing = await f.execute([
    "printf 'second\\n' >> lesson.txt",
    "git add lesson.txt",
    "git -c user.name=Repa -c user.email=repa@example.invalid commit -qm second",
    "git log -1 --format=%s",
  ].join(" && "));
  assert.equal(existing.exitCode, 0, existing.stderr);
  assert.equal(existing.stdout, "second\n");
  const protectedWrite = await f.execute("printf denied > .repa/secret.txt");
  assert.notEqual(protectedWrite.exitCode, 0);
  assert.equal(await readFile(path.join(f.protectedPath, "secret.txt"), "utf8"), "protected\n");
  for (const name of [".agents", ".codex"]) {
    assert(!existsSync(path.join(f.cwd, name)), `宿主多出 ${name}`);
  }
});

test("缺少相邻固定 helper 的安装副本拒绝执行，不回退为宿主 shell", { skip: !linux }, async (t) => {
  const f = await fixture(t);
  const install = path.join(f.root, "installation");
  const execution = path.join(install, "src", "execution");
  await mkdir(execution, { recursive: true });
  await writeFile(path.join(install, "package.json"), '{"type":"module"}\n');
  for (const name of ["process.ts", "sandbox.ts"]) {
    await copyFile(new URL(`../src/execution/${name}`, import.meta.url), path.join(execution, name));
  }
  await copyFile(new URL("../src/errors.ts", import.meta.url), path.join(install, "src", "errors.ts"));
  const marker = path.join(f.cwd, "must-not-run");
  const probe = path.join(install, "probe.mjs");
  await writeFile(probe, `import { runCommand } from "./src/execution/process.ts";
try {
  await runCommand({command:${JSON.stringify(`touch ${quote(marker)}`)},cwd:${JSON.stringify(f.cwd)},policy:{mode:"restricted",readPaths:[],writePaths:[],network:false},protectedPaths:[],onData(){}});
  process.exitCode=2;
} catch (error) {
  if (error.code !== "sandbox_unavailable") throw error;
  console.log(error.code);
}
`);
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), probe], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "sandbox_unavailable\n");
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

for (const invalid of ["missing", "tampered"] as const) {
  test(`安装副本的相邻 bwrap ${invalid} 时拒绝执行，不改用系统 bwrap`, { skip: restrictedSkip }, async (t) => {
    const f = await fixture(t);
    const install = path.join(f.root, "installation");
    const execution = path.join(install, "src", "execution");
    const resources = path.join(install, "resources", "sandbox", "linux-x64");
    await mkdir(execution, { recursive: true });
    await mkdir(path.join(resources, "codex-resources"), { recursive: true });
    await writeFile(path.join(install, "package.json"), '{"type":"module"}\n');
    for (const name of ["process.ts", "sandbox.ts"]) {
      await copyFile(new URL(`../src/execution/${name}`, import.meta.url), path.join(execution, name));
    }
    await copyFile(new URL("../src/errors.ts", import.meta.url), path.join(install, "src", "errors.ts"));
    await copyFile(new URL("../resources/sandbox/linux-x64/codex-linux-sandbox", import.meta.url), path.join(resources, "codex-linux-sandbox"));
    const marker = path.join(f.cwd, "must-not-run");
    if (invalid === "tampered") {
      const replacement = path.join(resources, "codex-resources", "bwrap");
      await writeFile(replacement, `#!/bin/bash\nprintf unexpected > ${quote(marker)}\n`);
      await chmod(replacement, 0o755);
    }
    const probe = path.join(install, "probe.mjs");
    await writeFile(probe, `import { runCommand } from "./src/execution/process.ts";
const result = await runCommand({command:${JSON.stringify(`touch ${quote(marker)}`)},cwd:${JSON.stringify(f.cwd)},policy:{mode:"restricted",readPaths:[],writePaths:[],network:false},protectedPaths:[],onData(stream,bytes){if(stream==="stderr")process.stderr.write(bytes);}});
if(result.exitCode===0)process.exitCode=2;
`);
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), probe], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, invalid === "missing" ? /bubblewrap is unavailable/ : /bundled bubblewrap digest mismatch/);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  });
}

test("受限网络拒绝真实 localhost 连接，显式 network 授权和 Full Access 可以访问", { skip: restrictedSkip }, async (t) => {
  const f = await fixture(t);
  const server = http.createServer((_request, response) => { response.end("network-available"); });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); }); });
  const address = server.address();
  assert(address && typeof address !== "string");
  const command = `python3 -c ${quote(`import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:${address.port}',timeout=1).read().decode())`)}`;
  const denied = await f.execute(command);
  assert.notEqual(denied.exitCode, 0);
  assert.equal(denied.stdout, "");
  const allowed = await f.execute(command, { ...restricted, network: true });
  assert.equal(allowed.exitCode, 0);
  assert.equal(allowed.stdout, "network-available\n");
  const unrestricted = await f.execute(command, fullAccess);
  assert.equal(unrestricted.exitCode, 0);
  assert.equal(unrestricted.stdout, "network-available\n");
});

test("受限普通 Node 脚本正常输出 console.log 和 console.error，输出读完后再报告完成", { skip: restrictedSkip }, async (t) => {
  const f = await fixture(t);
  const script = path.join(f.cwd, "console.mjs");
  await writeFile(script, 'console.log("普通输出"); console.error("诊断输出"); console.log("x".repeat(256 * 1024)); process.exitCode = 7;\n');
  const policy: ExecutionPolicy = { mode: "restricted", readPaths: [process.execPath], writePaths: [], network: false };
  let stdout = "";
  let stderr = "";
  let observed: { stdout: string; stderr: string } | undefined;
  const result = await runCommand({
    command: `${quote(process.execPath)} ${quote(script)}`, cwd: f.cwd, policy, protectedPaths: [],
    onData(stream, bytes) {
      if (stream === "stdout") stdout += bytes.toString("utf8");
      else stderr += bytes.toString("utf8");
    },
    onExited() { observed = { stdout, stderr }; },
  });
  assert.equal(result.exitCode, 7);
  assert.equal(stdout, `普通输出\n${"x".repeat(256 * 1024)}\n`);
  assert.equal(stderr, "诊断输出\n");
  assert.deepEqual(observed, { stdout, stderr });
});

test("helper 在真实 preflight monitor 建立后收到取消，完成探测收尾但不继续执行用户命令", { skip: restrictedSkip, timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "preflight-barrier.c");
  const library = path.join(f.root, "preflight-barrier.so");
  const ready = path.join(f.root, "preflight-ready");
  const barrier = path.join(f.root, "preflight-barrier");
  const marker = path.join(f.cwd, "must-not-run");
  // 只在真实 signalfd 创建后建立屏障；不替换 monitor、namespace 或信号处理。
  await writeFile(source, `#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/signalfd.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdlib.h>
int signalfd(int fd, const sigset_t *mask, int flags) {
  int (*original)(int, const sigset_t *, int) = dlsym(RTLD_NEXT, "signalfd");
  int result = original(fd, mask, flags);
  const char *ready = getenv("REPA_PREFLIGHT_READY");
  const char *barrier = getenv("REPA_PREFLIGHT_BARRIER");
  if (result >= 0 && ready && barrier) {
    int ready_fd = open(ready, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (ready_fd >= 0) {
      close(ready_fd);
      int gate = open(barrier, O_RDONLY);
      char byte;
      if (gate < 0 || read(gate, &byte, 1) != 1) _exit(99);
      close(gate);
    }
  }
  return result;
}
`);
  const compiled = spawnSync("cc", ["-shared", "-fPIC", source, "-ldl", "-o", library], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.stderr);
  const created = spawnSync("/usr/bin/mkfifo", [barrier], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  const gate = await open(barrier, constants.O_RDWR);
  const prepared = await prepareCommand({ command: `printf unexpected > ${quote(marker)}`, cwd: f.cwd, policy: restricted, protectedPaths: [] });
  // 此环境只作用于测试中直接启动的 helper；产品入口继续过滤 LD_PRELOAD。
  const child = spawn(prepared.executable, prepared.args, {
    cwd: f.cwd, detached: true, stdio: "ignore",
    env: { ...prepared.env, LD_PRELOAD: library, REPA_PREFLIGHT_READY: ready, REPA_PREFLIGHT_BARRIER: barrier },
  });
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => { resolve({ code, signal }); });
  });
  t.after(async () => {
    await gate.write("release");
    child.kill("SIGTERM");
    await completed;
    await gate.close();
    await prepared.cleanup?.();
  });
  await until(() => existsSync(ready), "preflight 未建立 signalfd 屏障");
  assert(child.pid);
  process.kill(-child.pid, "SIGTERM");
  await gate.write("release");
  const result = await completed;
  assert.equal(result.code, 143);
  assert.equal(result.signal, null);
  assert(!existsSync(marker), "取消 preflight 后仍执行了用户命令");
});
