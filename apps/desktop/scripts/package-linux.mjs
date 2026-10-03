import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
const packages = ["repa", "@repa/learning", "@repa/materials", "@repa/organization", "@repa/planning", "@repa/review"];

if (!npm) throw new Error("请通过 npm run package:linux --workspace=@repa/desktop 启动打包。");
if (process.platform !== "linux" || process.arch !== "x64") throw new Error("当前交付入口仅支持 Linux x64。");

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
    const source = path.join(root, "node_modules/electron/dist", name);
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

// sandbox 的发行副本被 git 忽略；每次由固定源码和缓存重新构建，并在原入口 strip --strip-debug。
await npmRun(["run", "build:sandbox", "--workspace=repa"]);
await npmRun(["run", "build:backend"]);
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
await copyFile(path.join(root, "package-lock.json"), path.join(application, "package-lock.json"));
await npmRun(["install", "--package-lock-only", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], application);
await npmRun(["ci", "--omit=dev", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], application);
manifest.dependencies = Object.fromEntries(archivesByPackage.map(({ name, version }) => [name, version]));
await writeFile(path.join(application, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await rm(path.join(application, "package-lock.json"));
const inventory = await copyLicenses();

const helper = "/opt/Repa/resources/app/node_modules/repa/resources/sandbox/linux-x64/codex-linux-sandbox";
const profile = path.join(work, "helper-apparmor");
const { stdout: policy } = await exec(process.execPath, [path.join(root, "packages/repa/scripts/sandbox-profile.mjs"),
  "--helper", helper, "--name", "repa-desktop-linux-sandbox"]);
await writeFile(profile, policy);
const templates = path.join(root, "node_modules/app-builder-lib/templates/linux");
const afterInstall = path.join(work, "after-install.sh");
const afterRemove = path.join(work, "after-remove.sh");
await writeFile(afterInstall, `${await readFile(path.join(templates, "after-install.tpl"), "utf8")}

# Repa helper 使用自己的 userns 附件规则，不改变全局 AppArmor 或 sysctl。
if apparmor_status --enabled > /dev/null 2>&1; then
  SOURCE='/opt/Repa/resources/helper-apparmor'
  TARGET='/etc/apparmor.d/repa-desktop-linux-sandbox'
  if apparmor_parser --skip-kernel-load --debug "$SOURCE" > /dev/null 2>&1; then
    install -m 0644 "$SOURCE" "$TARGET"
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; }; then
      apparmor_parser --replace --write-cache --skip-read-cache "$TARGET" || echo 'Repa 沙箱 AppArmor profile 未能加载；受限命令可能不可用。' >&2
    fi
  else
    echo 'Repa 沙箱 AppArmor profile 不受此系统支持；受限命令可能不可用。' >&2
  fi
fi
`);
await writeFile(afterRemove, `${await readFile(path.join(templates, "after-remove.tpl"), "utf8")}

if [ "$1" = 'remove' ] || [ "$1" = 'purge' ]; then
  TARGET='/etc/apparmor.d/repa-desktop-linux-sandbox'
  if [ -f "$TARGET" ]; then
    if apparmor_status --enabled > /dev/null 2>&1 && ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; }; then
      apparmor_parser --remove "$TARGET" || true
    fi
    rm -f "$TARGET"
  fi
fi
`);

await build({
  projectDir: desktop,
  targets: Platform.LINUX.createTarget(["deb"], Arch.x64),
  config: {
    appId: "org.utopia-v.repa",
    productName: "Repa",
    artifactName: "Repa-${version}-${arch}.${ext}",
    directories: { app: application, output },
    electronVersion: "44.3.0",
    electronDist: path.join(root, "node_modules/electron/dist"),
    // helper、相邻 bwrap 和材料 worker 都按真实文件路径启动；先保留物理安装布局。
    asar: false,
    npmRebuild: false,
    files: ["out/**/*", "node_modules/**/*", "third-party-licenses/**/*", "package.json"],
    extraResources: [{ from: profile, to: "helper-apparmor" }],
    linux: { category: "Education", executableName: "repa", target: "deb", syncDesktopName: true },
    deb: {
      maintainer: "Utopia-V",
      afterInstall,
      afterRemove,
      depends: ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6", "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0", "ripgrep", "poppler-utils", "apparmor"],
    },
  },
});
const deb = path.join(output, `Repa-${manifest.version}-amd64.deb`);
const { stdout: verification } = await exec(process.execPath, [path.join(desktop, "scripts/verify-linux-package.mjs"), deb], {
  cwd: root,
  maxBuffer: 4 * 1024 * 1024,
});
console.log(JSON.stringify({ output, packages: packed.map(({ name, version }) => ({ name, version })), licenses: inventory.length,
  verification: JSON.parse(verification) }, null, 2));
