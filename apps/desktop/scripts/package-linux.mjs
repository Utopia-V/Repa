import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Arch, Platform, build } from "electron-builder";

const exec = promisify(execFile);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const root = path.resolve(desktop, "../..");
const work = path.join(root, ".scratch/desktop-delivery");
const archives = path.join(work, "archives");
const application = path.join(work, "application");
const output = path.join(work, "dist");
const npm = process.env.npm_execpath;
// 后端及其插件：学习插件由主进程按包名找到，连同它依赖的工作区包一起装进安装包。
const packages = ["@repa/base", "@repa/space-history", "@repa/learning", "@repa/learning-model", "@repa/python-runner"];

if (!npm) throw new Error("请通过 npm run package:linux --workspace=@repa/desktop 启动打包。");
if (process.platform !== "linux" || process.arch !== "x64") throw new Error("当前交付入口仅支持 Linux x64。");

// 使用 Electron 的官方入口定位发行目录，兼容干净 npm ci 后的延迟下载。
const electronDirectory = path.dirname(createRequire(import.meta.url)("electron"));

async function npmRun(args, cwd = root) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [npm, ...args], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
    });
    if (stderr) process.stderr.write(stderr);
    return stdout;
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}

// 主进程的 repa 协议从 app/pyodide/ 提供这些文件，见 src/main/python-runtime.ts。
const PYODIDE_FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];
// @repa/python-runner 的 runner.py 在模块顶层导入它们，页面里的运行器加载的也是它们及其依赖。
const RUNNER_PACKAGES = ["numpy", "pandas"];

/** 把 Pyodide 文件和 runner.py 要的 wheel 放进安装包；wheel 按 pyodide-lock.json 核对 SHA-256，缺失或不符就停止打包。 */
async function copyPythonRuntime() {
  const pyodideDirectory = path.dirname(createRequire(import.meta.url).resolve("pyodide/package.json"));
  const { version } = JSON.parse(await readFile(path.join(pyodideDirectory, "package.json"), "utf8"));
  const { defaultPackagesDirectory } = await import("@repa/python-runner");
  const source = defaultPackagesDirectory(version);
  const target = path.join(application, "pyodide");
  await mkdir(path.join(target, "packages"), { recursive: true });
  for (const name of PYODIDE_FILES) await copyFile(path.join(pyodideDirectory, name), path.join(target, name));
  const lock = JSON.parse(await readFile(path.join(pyodideDirectory, "pyodide-lock.json"), "utf8"));
  const wheels = new Map();
  const visit = (name) => {
    if (wheels.has(name)) return;
    const entry = lock.packages[name];
    if (!entry) throw new Error(`Pyodide ${version} 的 lockfile 里没有 ${name}`);
    wheels.set(name, entry);
    for (const dependency of entry.depends) visit(dependency);
  };
  for (const name of RUNNER_PACKAGES) visit(name);
  for (const { file_name: file, sha256 } of wheels.values()) {
    let content;
    try {
      content = await readFile(path.join(source, file));
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`${source} 里缺少 ${file}，先运行 npm run course:runtime 准备离线包`);
      throw error;
    }
    if (createHash("sha256").update(content).digest("hex") !== sha256) throw new Error(`${file} 的 SHA-256 与 pyodide-lock.json 不符`);
    await writeFile(path.join(target, "packages", file), content);
  }
  return { pyodide: version, wheels: [...wheels.values()].map((entry) => entry.file_name).sort() };
}

async function copyLicenses() {
  const inventory = [];
  const notices = path.join(application, "third-party-licenses");
  const seen = new Set();
  const record = async (directory) => {
    const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    const identifier = `${manifest.name}@${manifest.version}`;
    if (seen.has(identifier)) return;
    seen.add(identifier);
    const licenseFiles = (await readdir(directory)).filter((name) => /^licen[cs]e(?:[.\-_]|$)|^copying(?:[.\-_]|$)/i.test(name));
    const copied = [];
    for (const name of licenseFiles) {
      const source = path.join(directory, name);
      const target = path.join(notices, identifier, name);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      copied.push(path.relative(application, target));
    }
    inventory.push({ name: manifest.name, version: manifest.version, license: manifest.license ?? null, files: copied });
  };
  const visit = async (modules) => {
    for (const entry of await readdir(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      const directory = path.join(modules, entry.name);
      if (entry.name.startsWith("@")) {
        await visit(directory);
        continue;
      }
      await record(directory);
      try {
        await visit(path.join(directory, "node_modules"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  };
  await visit(path.join(application, "node_modules"));
  const rendererDependencies = (await npmRun(["ls", "--all", "--omit=dev", "--workspace=@repa/desktop", "--parseable"]))
    .split("\n").filter((directory) => directory.startsWith(`${root}/node_modules/`) && directory !== path.join(root, "node_modules/@repa/desktop"));
  for (const directory of rendererDependencies) await record(directory);
  for (const name of ["LICENSE", "LICENSES.chromium.html"]) {
    const source = path.join(electronDirectory, name);
    const target = path.join(notices, "electron", name);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  inventory.sort((left, right) => left.name.localeCompare(right.name));
  await writeFile(path.join(notices, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  return inventory;
}

await rm(work, { recursive: true, force: true });
await mkdir(archives, { recursive: true });
await mkdir(application);

await npmRun(["run", "build", "--workspace=@repa/desktop"]);
const packed = Object.values(JSON.parse(await npmRun([
  "pack", "--ignore-scripts", "--json", "--pack-destination", archives,
  ...packages.map((name) => `--workspace=${name}`),
])));
if (packed.length !== packages.length) throw new Error("后端 workspace 未全部生成安装包。");
const archivesByPackage = [];
for (const { name, filename, version } of packed) {
  const source = path.join(archives, filename);
  const digest = createHash("sha256").update(await readFile(source)).digest("hex").slice(0, 16);
  const archived = `${filename.slice(0, -4)}-${digest}.tgz`;
  await rename(source, path.join(archives, archived));
  archivesByPackage.push({ name, version, filename: archived });
}
const dependencies = Object.fromEntries(archivesByPackage.map(({ name, filename }) => [name, `file:../archives/${filename}`]));
const manifest = {
  name: "repa-desktop",
  version: JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8")).version,
  private: true,
  type: "module",
  main: "out/main/index.js",
  description: "Repa 桌面学习应用",
  homepage: "https://github.com/Utopia-V/repa",
  author: "Utopia-V",
  desktopName: "repa",
  dependencies,
};
await writeFile(path.join(application, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await cp(path.join(desktop, "out"), path.join(application, "out"), { recursive: true });
const python = await copyPythonRuntime();
await copyFile(path.join(root, "package-lock.json"), path.join(application, "package-lock.json"));
await npmRun(["install", "--package-lock-only", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], application);
await npmRun(["ci", "--omit=dev", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], application);
manifest.dependencies = Object.fromEntries(archivesByPackage.map(({ name, version }) => [name, version]));
await writeFile(path.join(application, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await rm(path.join(application, "package-lock.json"));
const inventory = await copyLicenses();

await build({
  projectDir: desktop,
  targets: Platform.LINUX.createTarget(["deb"], Arch.x64),
  config: {
    appId: "org.utopia-v.repa",
    productName: "Repa",
    artifactName: "Repa-${version}-${arch}.${ext}",
    directories: { app: application, output },
    electronVersion: "44.3.0",
    electronDist: electronDirectory,
    // Node 宿主通过 CLI 的物理路径启动底座，保留物理安装布局。
    asar: false,
    npmRebuild: false,
    files: ["out/**/*", "pyodide/**/*", "node_modules/**/*", "third-party-licenses/**/*", "package.json"],
    linux: { category: "Education", executableName: "repa", target: "deb", syncDesktopName: true },
    deb: {
      maintainer: "Utopia-V",
      depends: ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0", "git", "ripgrep"],
    },
  },
});
const deb = path.join(output, `Repa-${manifest.version}-amd64.deb`);
const { stdout: verification } = await exec(process.execPath, [path.join(desktop, "scripts/verify-linux-package.mjs"), deb], {
  cwd: root,
  maxBuffer: 4 * 1024 * 1024,
});
console.log(JSON.stringify({ output, packages: packed.map(({ name, version }) => ({ name, version })), python, licenses: inventory.length,
  verification: JSON.parse(verification) }, null, 2));
