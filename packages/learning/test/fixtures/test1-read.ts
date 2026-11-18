/**
 * 子进程入口：按一份 JSON 清单在给定时刻读测试版固定数据的空间，读数按清单顺序写成 JSON 数组到标准输出。
 * 清单的每一项是 { root, at, model }：空间目录、时刻（Unix 毫秒）、有没有可用的模型。
 * 时区由父进程经 TZ 定下；学习插件按进程的时区算本地日期，所以这里先核对。
 *   tsx test1-read.ts <清单文件>
 */
import { readFile } from "node:fs/promises";
import { readSpace, TIME_ZONE } from "./test1-readings.js";

const [list] = process.argv.slice(2);
if (!list) throw new Error("用法：test1-read.ts <清单文件>");
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (zone !== TIME_ZONE) throw new Error(`进程的时区是 ${zone}，取数要在 ${TIME_ZONE}：用 TZ=${TIME_ZONE} 启动`);
const readings: unknown[] = [];
for (const entry of JSON.parse(await readFile(list, "utf8")) as { root: string; at: number; model: boolean }[]) {
  readings.push(await readSpace(entry.root, entry.at, entry.model));
}
process.stdout.write(`${JSON.stringify(readings)}\n`);
