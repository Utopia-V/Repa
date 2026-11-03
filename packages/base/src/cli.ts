#!/usr/bin/env node
import type { Plugin } from "./plugin.js";
import { startServer } from "./protocol/server.js";
import { loadPlugin } from "./plugins/manifest.js";

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write("用法：repa-base serve [--home 目录] [--port 端口] [--plugin 构建目录] [--no-general-agent] [--direct-agent Agent] [--git Git 程序的绝对路径] [--close-on-stdin-end]\n");
    return;
  }
  if (args.shift() !== "serve") throw new Error("请使用 repa-base serve 启动本机服务");
  let home: string | undefined;
  let port: number | undefined;
  let generalAgent = true;
  let closeOnStdinEnd = false;
  let directAgents: string[] | undefined;
  let gitPath: string | undefined;
  const plugins: Plugin[] = [];
  while (args.length) {
    const option = args.shift();
    if (option === "--no-general-agent") {
      generalAgent = false;
      continue;
    }
    if (option === "--close-on-stdin-end") {
      closeOnStdinEnd = true;
      continue;
    }
    const value = args.shift();
    if (!value) throw new Error(`${option ?? "参数"} 缺少值`);
    switch (option) {
      case "--home":
        home = value;
        break;
      case "--port":
        if (!/^\d+$/.test(value) || Number(value) > 65535) {
          throw new Error("端口应当是 0 到 65535 的整数");
        }
        port = Number(value);
        break;
      case "--plugin": {
        plugins.push(await loadPlugin(value));
        break;
      }
      case "--git":
        gitPath = value;
        break;
      case "--direct-agent":
        // 可以重复；给出后只有这些 Agent 能直接对话，覆盖定义中的 direct。
        directAgents = [...(directAgents ?? []), value];
        break;
      default:
        throw new Error(`未知参数：${option ?? ""}`);
    }
  }
  const server = await startServer({ home, port, plugins, generalAgent, directAgents, gitPath, token: process.env.REPA_TOKEN });
  const stop = () => {
    server.close().catch(() => {
      process.stderr.write("关闭服务失败\n");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (closeOnStdinEnd) {
    // 拉起服务的进程不往 stdin 写内容，只用它表示自己还在：它结束 stdin 或自身退出时，这里读到结尾或管道错误。
    // Windows 没有能投递给子进程的 SIGTERM，这是两个平台共用的关闭请求。
    process.stdin.once("end", stop);
    process.stdin.on("error", stop);
    process.stdin.resume();
    // 拉起服务的进程退出后，stdout 和 stderr 不再有人读，写入会报管道断开；这不能打断收尾。
    process.stdout.on("error", () => {});
    process.stderr.on("error", () => {});
  }
  // stdout 是拉起进程与可信前端之间的私密连接交接通道。
  process.stdout.write(`${JSON.stringify(server.connection)}\n`);
  await server.closed;
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  if (closeOnStdinEnd) {
    process.stdin.removeListener("end", stop);
    process.stdin.removeListener("error", stop);
    // 由信号关闭时 stdin 可能还开着，不再读取它，进程才能退出。
    process.stdin.destroy();
  }
}

try {
  await run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "启动服务失败"}\n`);
  process.exitCode = 1;
}
