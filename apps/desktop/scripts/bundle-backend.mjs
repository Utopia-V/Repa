/**
 * 把应用目录里按锁文件装好的后端（node_modules）打成少数几个文件，见
 * .agents/notes/proposed/architecture/2026-11-18-backend-bundle.md。
 *
 * Windows 上 Defender 逐个扫描新文件，代价按文件数计：一万多个小文件让安装多出约 40 秒，
 * 后端第一次启动读的约 1800 个文件让首次打开多出十几秒。打包后后端的代码在 node_modules/@repa/base/dist 下平铺的几十个文件里，
 * 其余文件只剩按路径读取的资源。
 *
 * 做法的要点是让打包后的代码看到的仍是原来的布局：
 * - 全部入口在一次构建里输出到 @repa/base/dist，与 base 原来的入口同名同位置，所以 package.json 的 exports、
 *   process.js 找 ./cli.js、folder-imports.js 找 ../plugin.js 都照旧，用户插件文件夹里的 @repa/base/plugin 与宿主、随包插件共用一份模块。
 * - 每个被打包的模块里的 import.meta.url 换成它在安装布局里原来的位置，import.meta.resolve、CommonJS 的 __dirname 同理；
 *   被打包的包留下所有非代码文件（package.json、wasm、数据），按路径找资源的代码就照常找到。
 * - 按路径加载的 JavaScript（worker）各自打成自足的文件，放回原来的位置。
 */
import { build, transform } from "esbuild";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** 不打包、原样留在 node_modules 的包：Linux 课程核对的沙箱用 Node 按路径加载它们，Landlock 按路径放行。 */
const EXTERNAL = ["pyodide", "ws"];

/** 随包插件：插件文件夹按 repa-plugin.json 的 entry 导入，那里留一行转出，指向这次构建里的入口。 */
const PLUGINS = ["@repa/learning", "@repa/materials"];

/**
 * 按路径启动的 worker：键是代码里算出的 worker 位置（相对 node_modules），source 是它的源。各自单独打成没有相对导入的文件。
 * Pi 按 PI_BUNDLED_NODE 打包时，codemode 的 worker 取 config.js 同目录的 codemode-worker.js，Pi 把它读进内存、
 * 以 data: URL 启动，所以它不能依赖自己的位置（dataUrl）；缩图的 worker 取 image-resize.js 同目录的 image-resize-worker.js。
 */
const WORKERS = {
  "@earendil-works/pi-coding-agent/dist/codemode-worker.js": { source: "@earendil-works/pi-codemode/dist/runtime/worker.js", dataUrl: true },
  "@earendil-works/pi-coding-agent/dist/utils/image-resize-worker.js": { source: "@earendil-works/pi-coding-agent/dist/utils/image-resize-worker.js", dataUrl: false },
};

/**
 * 含 new Worker( 而不需要上面那张表的模块，及其理由。依赖升级后出现新的 worker，构建就停下，免得漏掉的文件到运行时才报错。
 */
const WORKERS_WITHOUT_FILES = {
  // 检查代码以字符串交给 worker（eval: true）。
  "@repa/base/dist/plugins/syntax-check.js": "eval",
  // 同样以字符串启动。
  "fflate/esm/index.mjs": "eval",
  // Node 里 pdf.js 用主线程的假 worker，不起 Worker。
  "unpdf/dist/pdfjs.mjs": "Node 里不用",
  // worker 的位置由 config.js 给出，见 WORKERS。
  "@earendil-works/pi-codemode/dist/runtime/host.js": "见 WORKERS",
  "@earendil-works/pi-coding-agent/dist/utils/image-resize.js": "见 WORKERS",
};

const CODE = /\.(?:[cm]?js|[cm]?ts|tsx|jsx|map)$/u;

// 每个输出文件开头：模块里 CommonJS 风格的 require 由它提供；__repaOutputUrl 是这个输出文件的位置，
// 模块原来的位置由它和一个相对路径算出（见 relocate），注入的代码因此不含 import.meta，CommonJS 模块里也能用。
// __repaResolve 按模块原来的位置解析 import.meta.resolve：createRequire 按 require 的条件解析，
// 现有用法只解析 package.json 和普通文件，与 import 条件下的结果相同。
const BANNER = [
  "import { createRequire as __repaCreateRequire } from \"node:module\";",
  "import { dirname as __repaDirname } from \"node:path\";",
  "import { fileURLToPath as __repaFileURLToPath, pathToFileURL as __repaPathToFileURL } from \"node:url\";",
  "const __repaOutputUrl = import.meta.url;",
  "const require = __repaCreateRequire(__repaOutputUrl);",
  "const __repaResolve = (base, specifier) => /^\\.{0,2}\\//u.test(specifier) ? new URL(specifier, base).href : __repaPathToFileURL(__repaCreateRequire(base).resolve(specifier)).href;",
].join(" ");

/** 依赖模块自身位置的写法，换成 relocate 在模块开头声明的变量。只换真正的表达式，字符串和注释里的同名文字不动。 */
const LOCATION = {
  "import.meta.url": "__repa_url",
  "import.meta.resolve": "__repa_resolve",
  "import.meta.filename": "__repa_filename",
  "import.meta.dirname": "__repa_dirname",
  __filename: "__repa_filename",
  __dirname: "__repa_dirname",
};

const posix = (file) => file.split(path.sep).join("/");

/** Repa 自己的工作区包（位于 node_modules 的第一层），不含它们底下嵌套安装的第三方包。 */
const isRepaPackage = (name) => name.startsWith("@repa/") && !name.includes("/node_modules/");

/** 包含这个文件的包目录（相对 node_modules，嵌套的 node_modules 照原样保留）。 */
function packageOf(relative) {
  const parts = relative.split("/");
  const last = parts.lastIndexOf("node_modules");
  const rest = parts.slice(last + 1);
  const name = rest[0].startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  return [...parts.slice(0, last + 1), ...name].join("/");
}

/**
 * 让模块看到的自身位置仍是安装布局里原来的位置。outputDirectory 是这次构建的输出目录（相对 node_modules）：
 * 一次构建的输出都平铺在这个目录里，所以原来的位置相对任何一个输出文件都是同一个相对路径。
 * __dirname、__filename 只替换没有声明过的引用，即 CommonJS 模块里由 Node 提供的那两个。
 */
function relocate(modules, outputDirectory) {
  return {
    name: "relocate",
    setup(builder) {
      builder.onLoad({ filter: /\.[cm]?js$/ }, async (args) => {
        const text = await readFile(args.path, "utf8");
        if (!/import\.meta|__dirname|__filename/u.test(text)) return undefined;
        const { code, warnings } = await transform(text, { loader: "js", define: LOCATION, sourcefile: args.path, sourcemap: "inline", logLevel: "silent" });
        if (warnings.length > 0) throw new Error(`${args.path}：${warnings.map((warning) => warning.text).join("；")}`);
        if (!code.includes("__repa_")) return undefined;
        const original = JSON.stringify(posix(path.relative(path.join(modules, outputDirectory), args.path)));
        const prelude = [
          `var __repa_url = new URL(${original}, __repaOutputUrl).href;`,
          "var __repa_filename = __repaFileURLToPath(__repa_url);",
          "var __repa_dirname = __repaDirname(__repa_filename);",
          "var __repa_resolve = (specifier) => __repaResolve(__repa_url, specifier);",
        ].join(" ");
        // 声明放在 hashbang 和 "use strict" 之后，不改变模块是否严格。
        const head = /^(?:#!.*\n)?(?:\s*(?:"use strict"|'use strict');?)*\s*/u.exec(code)[0];
        return { contents: `${head}${prelude}\n${code.slice(head.length)}`, loader: "js" };
      });
    },
  };
}

/** cli 的入口先打开 source map，再加载服务：报错的堆栈指向原来的源文件。source map 只在生成堆栈时才读。 */
function cliEntry(cli) {
  return {
    name: "cli-entry",
    setup(builder) {
      builder.onResolve({ filter: /^repa-cli-entry$/ }, () => ({ path: "cli", namespace: "repa-cli-entry" }));
      builder.onLoad({ filter: /.*/, namespace: "repa-cli-entry" }, () => ({
        contents: `process.setSourceMapsEnabled(true);\nawait import(${JSON.stringify(cli)});\n`,
        resolveDir: path.dirname(cli),
        loader: "js",
      }));
    },
  };
}

function failOnWarnings(result, what) {
  if (result.warnings.length > 0) {
    throw new Error(`${what}打包时有警告：\n${result.warnings.map((warning) => `${warning.location?.file ?? ""} ${warning.text}`).join("\n")}`);
  }
}

async function countFiles(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) count++;
  }
  return count;
}

async function copyTree(source, target, keep) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") await copyTree(from, to, keep);
    } else if (keep(from)) {
      await mkdir(target, { recursive: true });
      await copyFile(from, to);
    }
  }
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

/** 把 application/node_modules 换成打包后的布局，返回前后的文件数和输出文件数。 */
export async function bundleBackend(application) {
  const modules = path.join(application, "node_modules");
  const staging = path.join(application, "node_modules.bundle");
  await rm(staging, { recursive: true, force: true });
  const outputDirectory = "@repa/base/dist";
  const base = await readJson(path.join(modules, "@repa/base/package.json"));

  // base 的每个导出与 cli 按原来的文件名输出，插件入口以“插件 id-plugin”命名。
  const entryPoints = { cli: "repa-cli-entry" };
  for (const [subpath, target] of Object.entries(base.exports)) {
    const file = target.import;
    if (!file.startsWith("./dist/") || file.slice("./dist/".length).includes("/")) throw new Error(`@repa/base 的导出 ${subpath} 不在 dist 的第一层：${file}`);
    entryPoints[path.basename(file, ".js")] = path.join(modules, "@repa/base", file);
  }
  const plugins = [];
  for (const name of PLUGINS) {
    const manifest = await readJson(path.join(modules, name, "repa-plugin.json"));
    const output = `${manifest.id}-plugin`;
    entryPoints[output] = path.join(modules, name, manifest.entry);
    plugins.push({ name, entry: manifest.entry, output });
  }

  const shared = {
    absWorkingDir: modules,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external: EXTERNAL,
    metafile: true,
    sourcemap: "linked",
    sourcesContent: false,
    logLevel: "silent",
    // Pi 对打包后的运行方式有专门的处理（扩展用内嵌的模块，codemode 的 worker 在旁边），由这个常量打开。
    define: { PI_BUNDLED_NODE: "true" },
    banner: { js: BANNER },
  };
  const result = await build({
    ...shared,
    entryPoints,
    splitting: true,
    outdir: path.join(staging, outputDirectory),
    plugins: [cliEntry(path.join(modules, "@repa/base/dist/cli.js")), relocate(modules, outputDirectory)],
  });
  failOnWarnings(result, "后端");
  const inputs = Object.keys(result.metafile.inputs).filter((input) => !input.startsWith("repa-cli-entry:"));

  for (const input of inputs) {
    const relative = posix(path.relative(modules, path.resolve(modules, input)));
    if (relative in WORKERS_WITHOUT_FILES) continue;
    if ((await readFile(path.join(modules, relative), "utf8")).includes("new Worker(")) {
      throw new Error(`${relative} 启动 worker，打包后 worker 的文件要另行处理：加进 bundle-backend.mjs 的 WORKERS 或 WORKERS_WITHOUT_FILES`);
    }
  }

  for (const [target, { source, dataUrl }] of Object.entries(WORKERS)) {
    const outfile = path.join(staging, target);
    const worker = await build({
      ...shared,
      entryPoints: [path.join(modules, source)],
      outfile,
      ...(dataUrl ? { banner: {}, sourcemap: false } : {}),
      plugins: dataUrl ? [] : [relocate(modules, path.posix.dirname(target))],
    });
    failOnWarnings(worker, source);
    if (dataUrl && /import\.meta|\brequire\(|from\s*["']\./u.test(await readFile(outfile, "utf8"))) {
      throw new Error(`${source} 打包后依赖自己的位置，不能以 data: URL 运行`);
    }
    inputs.push(...Object.keys(worker.metafile.inputs));
  }

  // 被打包的包只留非代码文件；Repa 自己的包留下 dist 之外的全部内容（课程、写课说明、Skill、CMap、Python 沙箱的脚本）。
  const packages = new Set(inputs.map((input) => packageOf(posix(path.relative(modules, path.resolve(modules, input))))));
  for (const name of packages) {
    const source = path.join(modules, name);
    const keep = isRepaPackage(name)
      ? (file) => !path.relative(source, file).startsWith(`dist${path.sep}`)
      : (file) => !CODE.test(file);
    await copyTree(source, path.join(staging, name), keep);
  }
  for (const name of EXTERNAL) await copyTree(path.join(modules, name), path.join(staging, name), () => true);

  // 除 base 外，Repa 包的代码都在 base/dist 里了：插件包只导出插件入口（主进程按它找插件文件夹），其余不再导出任何模块。
  for (const name of packages) {
    if (!isRepaPackage(name) || name === "@repa/base") continue;
    const manifestFile = path.join(staging, name, "package.json");
    const { exports: _exports, bin: _bin, main: _main, types: _types, ...manifest } = await readJson(manifestFile);
    const plugin = plugins.find((entry) => entry.name === name);
    if (plugin !== undefined) {
      manifest.exports = { ".": `./${plugin.entry}` };
      const stub = path.join(staging, name, plugin.entry);
      const relative = posix(path.relative(path.dirname(stub), path.join(staging, outputDirectory, `${plugin.output}.js`)));
      await mkdir(path.dirname(stub), { recursive: true });
      await writeFile(stub, `export * from ${JSON.stringify(relative)};\nexport { default } from ${JSON.stringify(relative)};\n`);
    }
    await writeJson(manifestFile, manifest);
  }

  const before = await countFiles(modules);
  await rm(modules, { recursive: true });
  await rename(staging, modules);
  return { before, after: await countFiles(modules), outputs: Object.keys(result.metafile.outputs).length, packages: packages.size };
}
