import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RepaFault } from "@repa/base";
import { checkFormat, type Host, type Plugin, type PluginInstance, type PluginMethod } from "@repa/base/plugin";
import { loadCourseSources, type CourseSource } from "./course-sources.js";
import { connectLearning } from "./flow.js";
import { LearningRecords } from "./records.js";
import { LearningSession } from "./session.js";
import { visibleLearningResponse } from "./submission-visibility.js";
import { connectTutor, TUTOR_AGENT } from "./tutor.js";

/** 学习记录的格式版本：2 起只记事实。版本 1 的开发数据不转换，提示删除后重新打开。 */
export const LEARNING_FORMAT_VERSION = 2;

/** 时间一律取自底座的 host.now()，插件不另设时钟；测试通过宿主的 now 拨动时间。 */
export interface LearningPluginOptions {
  sources?: CourseSource[];
  /** 默认装配教学流程；测试等自定义接入复用同一个学习会话。 */
  connect?: (session: LearningSession, host: Host) => Promise<Pick<PluginInstance, "methods" | "close">>;
}

export function createLearningPlugin(options: LearningPluginOptions = {}): Plugin {
  return {
    id: "learning",
    async open(host) {
      const format = path.join(host.space.dataDir, "format.json");
      const entries = await readdir(host.space.dataDir);
      if (entries.length === 0) {
        await writeFile(format, `${JSON.stringify({ version: LEARNING_FORMAT_VERSION })}\n`, { flag: "wx", mode: 0o600 });
      } else if (!entries.includes("format.json")) {
        throw new RepaFault("unknown_data_format", "学习插件的数据没有格式标记，可能是旧的开发数据；删除 .repa/plugins/learning/ 后重新打开空间");
      }
      if (await checkFormat(format, LEARNING_FORMAT_VERSION) < LEARNING_FORMAT_VERSION) {
        throw new RepaFault("unknown_data_format", "学习记录是旧格式的开发数据，不再读取；删除 .repa/plugins/learning/ 后重新打开空间");
      }
      const sources = options.sources ?? [{ kind: "bundled", directory: fileURLToPath(new URL("../courses/python/", import.meta.url)) }];
      const course = await loadCourseSources(sources, host.files);
      const records = await LearningRecords.open(path.join(host.space.dataDir, "records.jsonl"), () => host.now());
      let session: LearningSession | undefined;
      try {
        session = await LearningSession.open(records, course, host);
        const opened = session;
        const connected = await (options.connect
          ? options.connect(opened, host)
          : connectLearning(opened, { beforeRestricted: () => host.abortAgent(TUTOR_AGENT) }));
        const tutor = await connectTutor(opened);
        const methods: Record<string, PluginMethod> = { ...connected.methods, ...tutor.methods };
        for (const [name, method] of Object.entries(methods)) {
          methods[name] = {
            ...method,
            async invoke(input, context) {
              try {
                const result = await method.invoke(input, context);
                return visibleLearningResponse(result, !opened.restricted());
              } catch (error) {
                if (error instanceof RepaFault) {
                  throw new RepaFault(error.code, error.message, visibleLearningResponse(error.details, !opened.restricted()));
                }
                throw error;
              }
            },
          };
        }
        return {
          ...tutor,
          methods,
          async close() {
            try {
              await connected.close?.();
            } finally {
              await opened.idle();
              await records.close();
            }
          },
        };
      } catch (error) {
        await session?.idle();
        await records.close();
        throw error;
      }
    },
  };
}
export default createLearningPlugin();
