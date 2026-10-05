import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const writerUrl = new URL("../src/diagnostic-stderr.ts", import.meta.url).href;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "repa-diagnostic-stderr-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return path.join(directory, "backend.log");
}

async function runWriter(t: TestContext, stderr: number | "pipe", managed: boolean, script: string) {
  const child = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "--eval",
    `import { writeDiagnosticLine } from ${JSON.stringify(writerUrl)};\n${script}`,
  ], {
    cwd: packageDirectory,
    env: { ...process.env, REPA_MANAGED_STDERR: managed ? "1" : "" },
    stdio: ["ignore", "pipe", stderr],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let stdout = "";
  let errors = "";
  assert(child.stdout);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      errors += chunk;
    });
  }
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`诊断输送子进程超时：${stdout}\n${errors}`));
    }, 10000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  assert.equal(code, 0, `诊断输送不应使进程失败：${errors}`);
  return { stdout, stderr: errors };
}

test("受管日志越过上限后截断原文件，后续整行仍通过原追加 fd 顺序写入", async (t) => {
  const file = await fixture(t);
  await writeFile(file, Buffer.alloc(MAX_LOG_BYTES - 1, "x"));
  const original = await stat(file);
  const handle = await open(file, "a", 0o600);
  try {
    await runWriter(t, handle.fd, true, `
      writeDiagnosticLine("第一行中文");
      writeDiagnosticLine("second\\n");
      writeDiagnosticLine("第三行");
      process.stdout.write("业务完成");
    `);
    assert.equal(await readFile(file, "utf8"), "第一行中文\nsecond\n第三行\n");
    const current = await handle.stat();
    assert.equal(current.ino, original.ino);
    assert.equal(current.size, Buffer.byteLength("第一行中文\nsecond\n第三行\n"));
    await handle.write("宿主仍使用原 fd\n");
    assert.equal(await readFile(file, "utf8"), "第一行中文\nsecond\n第三行\n宿主仍使用原 fd\n");
  } finally {
    await handle.close();
  }
});

test("受管日志按实际文件大小处理未经过诊断输送器的第三方输出", async (t) => {
  const file = await fixture(t);
  const handle = await open(file, "a", 0o600);
  try {
    await runWriter(t, handle.fd, true, `
      const { writeSync } = await import("node:fs");
      writeSync(2, Buffer.alloc(${MAX_LOG_BYTES}, "x"));
      writeDiagnosticLine("第三方输出后仍有界");
    `);
    assert.equal(await readFile(file, "utf8"), "第三方输出后仍有界\n");
  } finally {
    await handle.close();
  }
});

test("宿主关闭自身日志句柄后，子进程仍独立使用继承 fd 写入受管日志", async (t) => {
  const file = await fixture(t);
  const handle = await open(file, "a", 0o600);
  const result = runWriter(t, handle.fd, true, 'writeDiagnosticLine("宿主句柄已关闭");');
  await handle.close();
  await result;
  assert.equal(await readFile(file, "utf8"), "宿主句柄已关闭\n");
});

test("未标记的用户重定向即使超过受管上限也保留原有字节", async (t) => {
  const file = await fixture(t);
  const original = Buffer.alloc(MAX_LOG_BYTES + 1, "x");
  await writeFile(file, original);
  const handle = await open(file, "a", 0o600);
  try {
    await runWriter(t, handle.fd, false, 'writeDiagnosticLine("保留用户文件");');
    assert.deepEqual(await readFile(file), Buffer.concat([original, Buffer.from("保留用户文件\n")]));
  } finally {
    await handle.close();
  }
});

test("普通前台通过 stderr 输出完整 Unicode 行，不污染 stdout", async (t) => {
  const result = await runWriter(t, "pipe", false, `
    writeDiagnosticLine("诊断🙂");
    writeDiagnosticLine("下一行\\n");
    process.stdout.write("业务响应");
  `);
  assert.deepEqual(result, { stdout: "业务响应", stderr: "诊断🙂\n下一行\n" });
});

for (const managed of [false, true]) {
  test(`${managed ? "受管" : "普通"} stderr fd 已关闭时忽略输送失败，业务与进程继续完成`, async (t) => {
    const result = await runWriter(t, "pipe", managed, `
      const { closeSync } = await import("node:fs");
      closeSync(2);
      writeDiagnosticLine("无法写入");
      writeDiagnosticLine("后续诊断也不阻断业务");
      process.stdout.write("业务完成");
    `);
    assert.deepEqual(result, { stdout: "业务完成", stderr: "" });
  });
}

test("受管 fd 可以检查大小但不能写入时，输送失败不影响业务与进程", async (t) => {
  const file = await fixture(t);
  await writeFile(file, "已有日志\n");
  const handle = await open(file, "r");
  try {
    const result = await runWriter(t, handle.fd, true, `
      writeDiagnosticLine("无法写入");
      process.stdout.write("业务完成");
    `);
    assert.equal(result.stdout, "业务完成");
    assert.equal(await readFile(file, "utf8"), "已有日志\n");
  } finally {
    await handle.close();
  }
});
