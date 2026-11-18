/**
 * 子进程入口：按一份 JSON 清单在给定时刻读测试版固定数据的空间，读数按清单顺序写成 JSON 数组到标准输出。
 * 清单的每一项是 { root, at, model }：空间目录、时刻（Unix 毫秒）、有没有可用的模型；或 { root, model, prefixes: true }：
 * 对这个空间学习记录的每个前缀取读数（见 readPrefixes）；或 { root, model, regrade }：升级以后再收到一笔补判（见 readRegrade）。
 *   tsx test1-read.ts <清单文件>
 *
 * 学习插件按进程的默认时区算本地日期（Intl.DateTimeFormat 的默认时区），标准答案是在 Asia/Shanghai 下取的。
 * 父进程经 TZ 定下时区；个别平台的 Node 不认 TZ 时，这里让 Intl.DateTimeFormat 缺省用这个时区，效果相同：
 * 学习插件与时间有关的计算只经 Intl.DateTimeFormat。
 */
import { readFile } from "node:fs/promises";
import { readPrefixes, readRegrade, readSpace, TIME_ZONE } from "./test1-readings.js";

if (Intl.DateTimeFormat().resolvedOptions().timeZone !== TIME_ZONE) {
  const Original = Intl.DateTimeFormat;
  const Zoned = function (locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    return new Original(locales, options?.timeZone === undefined ? { ...options, timeZone: TIME_ZONE } : options);
  } as unknown as typeof Intl.DateTimeFormat;
  Object.assign(Zoned, { supportedLocalesOf: Original.supportedLocalesOf.bind(Original), prototype: Original.prototype });
  Intl.DateTimeFormat = Zoned;
}

const [list] = process.argv.slice(2);
if (!list) throw new Error("用法：test1-read.ts <清单文件>");
const readings: unknown[] = [];
for (const entry of JSON.parse(await readFile(list, "utf8")) as { root: string; at?: number; model: boolean; prefixes?: true; regrade?: string }[]) {
  if (entry.prefixes) readings.push(await readPrefixes(entry.root, entry.model));
  else if (entry.regrade !== undefined) readings.push(await readRegrade(entry.root, entry.regrade, entry.model));
  else readings.push(await readSpace(entry.root, entry.at ?? 0, entry.model));
}
process.stdout.write(`${JSON.stringify(readings)}\n`);
