import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const resourceDir = fileURLToPath(new URL("../resources/sandbox/", import.meta.url));
const source = JSON.parse(await readFile(path.join(resourceDir, "source.json"), "utf8"));

function options(args) {
  const result = {
    cacheDir: path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "repa", "sandbox"),
    outputDir: path.join(resourceDir, "linux-x64"),
    jobs: String(Math.min(os.availableParallelism(), 16)),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help") {
      console.log("用法：node scripts/build-sandbox.mjs [--cache-dir PATH] [--output-dir PATH] [--jobs N]");
      console.log("构建固定 Codex Linux x64 helper 与带父生命周期修复的 bubblewrap；不调用 Codex 应用。");
      process.exit(0);
    }
    const key = { "--cache-dir": "cacheDir", "--output-dir": "outputDir", "--jobs": "jobs" }[arg];
    const value = args[index + 1];
    if (!key || !value || value.startsWith("--")) {
      throw new Error(`无效参数：${arg}`);
    }
    result[key] = value;
    index += 1;
  }
  if (!/^[1-9]\d*$/.test(result.jobs)) {
    throw new Error("--jobs 必须是正整数");
  }
  result.cacheDir = path.resolve(result.cacheDir);
  result.outputDir = path.resolve(result.outputDir);
  return result;
}

async function run(command, args, { cwd, env, capture = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
    }
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${command} 失败：${signal ?? code}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function verify(file, expected) {
  const actual = await sha256(file);
  if (actual !== expected) {
    throw new Error(`${file} SHA-256 不符：预期 ${expected}，实际 ${actual}`);
  }
}

async function downloadVerified(file, url, expected, aptCache) {
  try {
    await verify(file, expected);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (aptCache) {
    try {
      await verify(aptCache, expected);
      await copyFile(aptCache, file);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  const pending = `${file}.download-${process.pid}`;
  try {
    await run("curl", ["--fail", "--location", "--output", pending, url]);
    await verify(pending, expected);
    await rename(pending, file);
  } finally {
    await rm(pending, { force: true });
  }
}

async function localPackage(cacheDir, dependency) {
  const archive = path.join(cacheDir, dependency.filename);
  await downloadVerified(archive, dependency.url, dependency.sha256, path.join("/var/cache/apt/archives", dependency.filename));
  const directory = path.join(cacheDir, dependency.filename.replace(/\.deb$/, ""));
  await run("dpkg-deb", ["--extract", archive, directory]);
  return directory;
}

async function bubblewrap(config, sourceDir) {
  const meson = await localPackage(config.cacheDir, source.bubblewrap.meson);
  const libcap = await localPackage(config.cacheDir, source.bubblewrap.libcapDev);
  const buildDirectory = path.join(config.cacheDir, `bubblewrap-build-${source.ref}`);
  const pkgconfig = path.join(config.cacheDir, "bubblewrap-pkgconfig");
  await mkdir(pkgconfig, { recursive: true });
  // 使用局部头文件与静态 libcap；不安装系统包，也不让生成物依赖缓存目录。
  await writeFile(path.join(pkgconfig, "libcap.pc"), [
    "Name: libcap", "Description: libcap - linux capabilities library", `Version: ${source.bubblewrap.libcapDev.version}`,
    `Cflags: -I${path.join(libcap, "usr", "include")}`,
    `Libs: ${path.join(libcap, "usr", "lib", "x86_64-linux-gnu", "libcap.a")}`, "",
  ].join("\n"));
  const env = {
    CC: process.env.CC ?? "clang",
    PYTHONPATH: path.join(meson, "usr", "lib", "python3", "dist-packages"),
    PKG_CONFIG_PATH: pkgconfig,
  };
  // Meson 构建目录引用具体源码和工具路径；每次重新配置，下载与 Cargo 缓存仍复用。
  await rm(buildDirectory, { recursive: true, force: true });
  const mesonArgs = [path.join(meson, "usr", "bin", "meson"), "setup", buildDirectory,
    path.join(sourceDir, source.bubblewrap.sourceDirectory), "--buildtype=release",
    "-Dselinux=disabled", "-Dman=disabled", "-Dtests=false", "-Dbash_completion=disabled", "-Dzsh_completion=disabled"];
  await run("python3", mesonArgs, { env });
  await run("ninja", ["-C", buildDirectory, "bwrap", "-j", config.jobs], { env });
  const executable = path.join(buildDirectory, "bwrap");
  return { executable, libcap, sha256: await sha256(executable),
    build: { command: ["python3", ...mesonArgs], compiler: await run(env.CC, ["--version"], { capture: true }), env } };
}

async function build(config) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("当前构建入口仅支持 Linux x64 Ubuntu 24.04 候选产物");
  }
  await mkdir(config.cacheDir, { recursive: true });
  const archive = path.join(config.cacheDir, `codex-${source.ref}.tar.gz`);
  await downloadVerified(archive, source.archiveUrl, source.archiveSha256);
  const sslFilename = `libssl-dev_${source.opensslDev.version}_amd64.deb`;
  const sslArchive = path.join(config.cacheDir, sslFilename);
  await downloadVerified(sslArchive, source.opensslDev.url, source.opensslDev.sha256, path.join("/var/cache/apt/archives", sslFilename));
  const sslDir = path.join(config.cacheDir, `openssl-dev-${source.opensslDev.version}`);
  await run("dpkg-deb", ["--extract", sslArchive, sslDir]);
  const sslLibDir = path.join(sslDir, "usr", "lib", "x86_64-linux-gnu");
  // 每次从已验证的归档覆盖上游文件；缓存仅放下载源码与 Cargo 产物。
  await run("tar", ["-xzf", archive, "-C", config.cacheDir]);
  const sourceDir = path.join(config.cacheDir, `codex-${source.ref}`, "codex-rs");
  await verify(path.join(sourceDir, "Cargo.lock"), source.cargoLockSha256);
  const lifecyclePatch = path.join(resourceDir, source.bubblewrap.patch);
  await verify(lifecyclePatch, source.bubblewrap.patchSha256);
  await run("patch", ["--batch", "--fuzz=0", "-p1", "-i", lifecyclePatch], { cwd: sourceDir });
  const bwrapSource = await bubblewrap(config, sourceDir);
  // 上游 release manifest 已升版，原锁的本地 workspace 版本尚未同步；第三方依赖保持原锁。
  const buildLock = path.join(resourceDir, "Cargo.lock");
  await verify(buildLock, source.buildCargoLockSha256);
  await copyFile(buildLock, path.join(sourceDir, "Cargo.lock"));
  const toolchains = await run("rustup", ["toolchain", "list"], { capture: true });
  if (!toolchains.split("\n").some((line) => line.split(" ")[0] === `${source.toolchain}-x86_64-unknown-linux-gnu`)) {
    await run("rustup", ["toolchain", "install", source.toolchain, "--profile", "minimal"]);
  }
  const targetDir = path.join(config.cacheDir, `target-${source.ref}`);
  const cargoArgs = [
    `+${source.toolchain}`, "build", "--release", "--locked",
    "--package", "codex-linux-sandbox", "--bin", "codex-linux-sandbox",
    "--target", source.target, "--target-dir", targetDir, "--jobs", config.jobs,
  ];
  const buildEnv = {
    CODEX_BWRAP_SHA256: bwrapSource.sha256,
    CARGO_NET_GIT_FETCH_WITH_CLI: "true",
    OPENSSL_INCLUDE_DIR: path.join(sslDir, "usr", "include"),
    OPENSSL_LIB_DIR: sslLibDir,
    OPENSSL_STATIC: "1",
    CPATH: [path.join(sslDir, "usr", "include", "x86_64-linux-gnu"), process.env.CPATH].filter(Boolean).join(":"),
  };
  await run("cargo", cargoArgs, { cwd: sourceDir, env: buildEnv });
  await verify(path.join(sourceDir, "Cargo.lock"), source.buildCargoLockSha256);
  await mkdir(path.join(config.outputDir, "codex-resources"), { recursive: true });
  const helper = path.join(config.outputDir, "codex-linux-sandbox");
  const bwrap = path.join(config.outputDir, "codex-resources", "bwrap");
  await copyFile(path.join(targetDir, source.target, "release", "codex-linux-sandbox"), helper);
  await copyFile(bwrapSource.executable, bwrap);
  await chmod(helper, 0o755);
  await chmod(bwrap, 0o755);
  // 许可随可执行文件一起交付，默认资源目录另保留原文来源。
  await mkdir(path.join(config.outputDir, "licenses"), { recursive: true });
  for (const file of ["codex-LICENSE", "codex-NOTICE", "bubblewrap-copyright", "bubblewrap-LGPL-2", "bubblewrap-GPL-2", "openssl-copyright"]) {
    await copyFile(path.join(resourceDir, "licenses", file), path.join(config.outputDir, "licenses", file));
  }
  await copyFile(path.join(bwrapSource.libcap, "usr", "share", "doc", "libcap-dev", "copyright"), path.join(config.outputDir, "licenses", "libcap-copyright"));
  const metadata = {
    source,
    rustc: await run("rustc", [`+${source.toolchain}`, "--version"], { capture: true }),
    command: ["cargo", ...cargoArgs],
    buildEnv,
    bubblewrapBuild: bwrapSource.build,
    bubblewrapSource: path.join(sourceDir, source.bubblewrap.sourceDirectory),
    helperSha256: await sha256(helper),
    bubblewrapSha256: await sha256(bwrap),
    helperDependencies: await run("ldd", [helper], { capture: true }),
    bubblewrapDependencies: await run("ldd", [bwrap], { capture: true }),
    platform: await run("lsb_release", ["--description", "--short"], { capture: true }),
  };
  await writeFile(path.join(config.outputDir, "build.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Linux x64 沙箱产物：${config.outputDir}`);
}

try {
  await build(options(process.argv.slice(2)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
