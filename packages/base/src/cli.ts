#!/usr/bin/env node
import type { Plugin } from "./plugin.js";
import { startServer } from "./protocol/server.js";
import { loadPlugin } from "./plugins/manifest.js";

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write("用法：repa-base serve [--home 目录] [--port 端口] [--plugin 构建目录] [--no-general-agent] [--direct-agent Agent]\n");
    return;
  }
  if (args.shift() !== "serve") throw new Error("请使用 repa-base serve 启动本机服务");
  let home: string | undefined;
  let port: number | undefined;
  let generalAgent = true;
  let directAgents: string[] | undefined;
  const plugins: Plugin[] = [];
  while (args.length) {
    const option = args.shift();
    if (option === "--no-general-agent") {
      generalAgent = false;
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
      case "--direct-agent":
        // 可以重复；给出后只有这些 Agent 能直接对话，覆盖定义中的 direct。
        directAgents = [...(directAgents ?? []), value];
        break;
      default:
        throw new Error(`未知参数：${option ?? ""}`);
    }
  }
  const server = await startServer({ home, port, plugins, generalAgent, directAgents, token: process.env.REPA_TOKEN });
  const stop = () => {
    server.close().catch(() => {
      process.stderr.write("关闭服务失败\n");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  // stdout 是拉起进程与可信前端之间的私密连接交接通道。
  process.stdout.write(`${JSON.stringify(server.connection)}\n`);
  await server.closed;
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

try {
  await run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "启动服务失败"}\n`);
  process.exitCode = 1;
}
