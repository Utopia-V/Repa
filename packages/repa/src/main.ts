// 后端的入口，repa 命令在后台启动它。--kb 指定知识库（默认 ~/Repa），--port 指定端口。
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { ensureModes } from "./map.js";
import { Sessions } from "./pi/sessions.js";
import { startServer } from "./server.js";

const { values } = parseArgs({ options: { kb: { type: "string" }, port: { type: "string", default: "7723" } } });
const root = path.resolve(values.kb ?? path.join(os.homedir(), "Repa"));
await mkdir(root, { recursive: true });
await ensureModes(root);
// REPA_MODELS_STORE 只供开发时把 Pi 的模型缓存写到别处，不碰 Pi 全局目录。
const sessions = await Sessions.create(root, process.env.REPA_MODELS_STORE ? { modelsStorePath: process.env.REPA_MODELS_STORE } : {});
const webRoot = fileURLToPath(new URL("../../../apps/web/dist", import.meta.url));
await startServer({ root, port: Number(values.port), sessions, webRoot });
console.log(`Repa 在 http://127.0.0.1:${values.port}/ 运行，知识库是 ${root}`);
