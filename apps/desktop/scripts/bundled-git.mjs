/**
 * 安装包带的 Git：学习者电脑上未必有 Git（Windows 默认没有，macOS 没装命令行工具时 /usr/bin/git 会弹安装框），空间历史又离不开它。
 * 从 GitHub Desktop 用的 dugite-native 里只取 git 主程序，Windows 上再带它链接的 DLL；空间历史用到的都是内置命令，
 * 不需要 https、凭据管理器等其余部分。子命令目录由底座的 gitPath 用 --exec-path 指回这里，见 @repa/space-history。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const RELEASE = "v2.56.0-2";
const MSYS2_SOURCES = "https://repo.msys2.org/mingw/sources";
const BASE_URL = `https://github.com/desktop/dugite-native/releases/download/${RELEASE}`;
// SHA-256 取自 Release 附带的 .sha256 文件，写死在这里：Release 的文件被替换时打包会停下，而不是带上换过的程序。
const ARCHIVES = {
  "darwin-arm64": {
    file: "dugite-native-v2.56.0-a44aeca-macOS-arm64.tar.gz",
    sha256: "1110de343de11cc6f469b782b60f36217b9199b5e06875dd65baa26dd60563c7",
    // 只链接系统库（libz、libiconv、CoreFoundation 等），单个文件就能运行。
    files: ["libexec/git-core/git"],
    licenses: [],
    version: "2.56.0",
    license: "GPL-2.0-only",
    sources: [
      "Git 源码：https://github.com/git/git/tree/v2.56.0",
      "dugite-native 的构建脚本：https://github.com/desktop/dugite-native/tree/v2.56.0-2",
    ],
  },
  "win32-x64": {
    file: "dugite-native-v2.56.0-a44aeca-windows-x64.tar.gz",
    sha256: "f1e17876337d7be143e5d51976da36643d65528125cfbc14d57f171de0fd5f14",
    // dugite-native 的 Windows 版放在 ucrt64/bin/，不是 Git for Windows 常见的 mingw64/bin/。
    // git.exe 导入表里不属于系统的就是这四个 DLL；UCRT 是 Windows 10 起系统自带的。
    files: ["ucrt64/bin/git.exe", "ucrt64/bin/libiconv-2.dll", "ucrt64/bin/libintl-8.dll", "ucrt64/bin/libpcre2-8-0.dll", "ucrt64/bin/zlib1.dll"],
    licenses: ["LICENSE.txt", ...["libiconv", "gettext-runtime", "pcre2", "zlib"].map((name) => `ucrt64/share/licenses/${name}`)],
    // 版本取自包里的 etc/package-versions.txt：git.exe 是 MSYS2 打包的 Git for Windows（git --version 为 2.56.0.windows.4），
    // libiconv 与 libintl（gettext-runtime）是 LGPL，pcre2 是 BSD-3-Clause，zlib 是 Zlib。
    version: "2.56.0.windows.4",
    license: "GPL-2.0-only AND LGPL-2.1-or-later AND BSD-3-Clause AND Zlib",
    sources: [
      "Git for Windows 源码：https://github.com/git-for-windows/git/tree/v2.56.0.windows.4",
      `mingw-w64-ucrt-x86_64-git 2.56.0.4-1：${MSYS2_SOURCES}/mingw-w64-git-2.56.0.4-1.src.tar.zst`,
      `mingw-w64-ucrt-x86_64-libiconv 1.19-1：${MSYS2_SOURCES}/mingw-w64-libiconv-1.19-1.src.tar.zst`,
      `mingw-w64-ucrt-x86_64-gettext-runtime 1.0-1：${MSYS2_SOURCES}/mingw-w64-gettext-1.0-1.src.tar.zst`,
      `mingw-w64-ucrt-x86_64-pcre2 10.49-1：${MSYS2_SOURCES}/mingw-w64-pcre2-10.49-1.src.tar.zst`,
      `mingw-w64-ucrt-x86_64-zlib 1.3.2-3：${MSYS2_SOURCES}/mingw-w64-zlib-1.3.2-3.src.tar.zst`,
      "dugite-native 的构建脚本：https://github.com/desktop/dugite-native/tree/v2.56.0-2",
    ],
  },
};
// macOS 的包里没有许可证文件，取同一版本 Git 源码里的 COPYING（GPLv2）。
const COPYING = {
  url: "https://raw.githubusercontent.com/git/git/v2.56.0/COPYING",
  sha256: "5b2198d1645f767585e8a88ac0499b04472164c0d2da22e75ecf97ef443ab32e",
};

/** 下载到 cache 并核对 SHA-256；已有且摘要相符就不再下载。 */
async function download(url, sha256, cache) {
  const target = path.join(cache, path.basename(new URL(url).pathname));
  const digest = (content) => createHash("sha256").update(content).digest("hex");
  try {
    if (digest(await readFile(target)) === sha256) return target;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // 网络卡住时尽早失败，不要一直挂到 CI 任务超时。
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok) throw new Error(`下载 ${url} 失败：HTTP ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  if (digest(content) !== sha256) throw new Error(`${url} 的 SHA-256 与记录不符`);
  await mkdir(cache, { recursive: true });
  await writeFile(`${target}.partial`, content);
  await rename(`${target}.partial`, target);
  return target;
}

/** Windows 上用系统自带的 bsdtar：PATH 里可能先是 Git for Windows 的 GNU tar，它把 C: 当成远程主机。 */
function tarExecutable() {
  return process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

/**
 * 把 git 放进 application/git/，许可证放进 third-party-licenses/git/。返回 git 在应用目录里的相对路径和许可证清单条目；
 * 没有对应构建的平台（Linux 上由发行版提供 Git）返回 undefined，桌面端照旧用 PATH 里的 git。
 */
export async function copyGit(application, cache) {
  const archive = ARCHIVES[`${process.platform}-${process.arch}`];
  if (!archive) return undefined;
  const source = await download(`${BASE_URL}/${archive.file}`, archive.sha256, cache);
  const extracted = await mkdtemp(path.join(cache, "extract-"));
  try {
    const members = [...archive.files, ...archive.licenses].map((name) => `./${name}`);
    await exec(tarExecutable(), ["-xzf", source, "-C", extracted, ...members]);
    const target = path.join(application, "git");
    await mkdir(target, { recursive: true });
    for (const name of archive.files) await cp(path.join(extracted, name), path.join(target, path.basename(name)));
    const executable = path.join(target, path.basename(archive.files[0]));
    await chmod(executable, 0o755);

    const notices = path.join(application, "third-party-licenses", `git@${archive.version}`);
    await mkdir(notices, { recursive: true });
    const copied = [];
    for (const name of archive.licenses) {
      const destination = path.join(notices, name.startsWith("ucrt64/share/licenses/") ? path.basename(name) : name);
      await cp(path.join(extracted, name), destination, { recursive: true });
      copied.push(destination);
    }
    if (archive.licenses.length === 0) {
      const copying = path.join(notices, "COPYING");
      await cp(await download(COPYING.url, COPYING.sha256, cache), copying);
      copied.push(copying);
    }
    // GPL 与 LGPL 要求能拿到对应源码：文件未经修改，指向上游的发行版与各自的源码包。
    const sourceNote = path.join(notices, "SOURCE.txt");
    await writeFile(sourceNote, [
      `Git ${archive.version}，取自 dugite-native ${RELEASE}（${archive.file}），未经修改。`,
      `发行版：https://github.com/desktop/dugite-native/releases/tag/${RELEASE}`,
      ...archive.sources,
      "",
    ].join("\n"));
    copied.push(sourceNote);
    await access(executable);
    return {
      executable: path.relative(application, executable),
      license: { name: "git", version: archive.version, license: archive.license, files: copied.map((file) => path.relative(application, file)) },
    };
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}
