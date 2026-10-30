import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { RepaFault } from "@repa/base";
import type { Host, PluginInstance, PreparedExport } from "@repa/base/plugin";
import { parse } from "@repa/base/protocol";
import { Type } from "typebox";
import { learningMethods } from "./protocol.js";
import { RECORDS_FILE } from "./records.js";

/** 写进导出包 learning.json 的版本信息：学习记录的格式版本、课程标识与版本；插件的代码版本另从清单读取。 */
export interface LearningExportInfo {
  recordsFormat: number;
  course: { id: string; version: string };
}

const PluginManifestSchema = Type.Object({ version: Type.String({ minLength: 1 }) });

/** 插件清单 repa-plugin.json 记下的代码版本；src 与构建后的 dist 到包根目录的距离相同。 */
async function pluginVersion(): Promise<string> {
  const value: unknown = JSON.parse(await readFile(new URL("../repa-plugin.json", import.meta.url), "utf8"));
  return parse(PluginManifestSchema, value).version;
}

/**
 * 导出学习数据，由学习者自行发给维护者校准学生模型。白名单固定：学习记录，以及 learning.json 中的插件、记录格式与课程的版本；
 * 学习者选择包含会话时，底座再收入空间的会话记录。export.prepare 冻结一份已脱敏的内容并返回清单，export.create 把同一份内容
 * 写成 zip，所以清单与 zip 一致，预览以后新增的记录不进入这份导出。只保留最近一次预览：写出成功、再次预览或关闭空间以后，
 * 旧的预览失效，export.create 以 export_expired 拒绝。
 */
export function connectExport(host: Host, info: LearningExportInfo): Pick<PluginInstance, "methods"> {
  let current: { id: string; prepared: PreparedExport } | undefined;
  return {
    methods: {
      "export.prepare": {
        parameters: learningMethods["export.prepare"].input,
        result: learningMethods["export.prepare"].result,
        async invoke(raw) {
          const { sessions } = parse(learningMethods["export.prepare"].input, raw);
          const about = { pluginVersion: await pluginVersion(), ...info };
          const prepared = await host.prepareExport({
            files: [
              { name: RECORDS_FILE, file: RECORDS_FILE },
              { name: "learning.json", text: `${JSON.stringify(about, null, 2)}\n` },
            ],
            sessions,
          });
          current = { id: randomUUID(), prepared };
          return { exportId: current.id, files: prepared.files };
        },
      },
      "export.create": {
        parameters: learningMethods["export.create"].input,
        result: learningMethods["export.create"].result,
        async invoke(raw) {
          const { exportId, directory } = parse(learningMethods["export.create"].input, raw);
          const chosen = current;
          if (chosen?.id !== exportId) throw new RepaFault("export_expired", "这份预览已经失效，请重新预览后再导出");
          const file = await chosen.prepared.write(directory);
          // 写出期间又预览了一次时，新的那份仍然有效。
          if (current === chosen) current = undefined;
          return { path: file };
        },
      },
    },
  };
}
