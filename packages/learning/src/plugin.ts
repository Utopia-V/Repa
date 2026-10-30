import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RepaFault } from "@repa/base";
import { checkFormat, type Host, type Plugin, type PluginInstance, type PluginMethod } from "@repa/base/plugin";
import { parse } from "@repa/base/protocol";
import { loadCourseSources, type CourseSource, type ResolvedCourse } from "./course-sources.js";
import { learningMethods, type LearningInput, type LearningState } from "./protocol.js";
import { LearningRecords } from "./records.js";
import { connectLearning } from "./flow.js";
import { visibleLearningResponse } from "./submission-visibility.js";
import { connectTutor, TUTOR_AGENT } from "./tutor.js";

export interface LearningPluginOptions {
  sources?: CourseSource[];
  now?: () => number;
  /** 默认装配教学流程；自定义接入复用同一持久入口。 */
  connect?: (records: LearningRecords, course: ResolvedCourse, host: Host) => Promise<Pick<PluginInstance, "methods" | "close">>;
}
export function createLearningPlugin(options: LearningPluginOptions = {}): Plugin {
  return {
    id: "learning",
    async open(host) {
      const format = path.join(host.space.dataDir, "format.json");
      const entries = await readdir(host.space.dataDir);
      if (entries.length === 0) {
        await writeFile(format, `${JSON.stringify({ version: 1 })}\n`, { flag: "wx", mode: 0o600 });
      } else if (!entries.includes("format.json")) {
        throw new RepaFault("unknown_data_format", "学习插件的数据没有格式标记，可能是旧的开发数据；删除 .repa/plugins/learning/ 后重新打开空间");
      }
      await checkFormat(format, 1);
      const sources = options.sources ?? [{ kind: "bundled", directory: fileURLToPath(new URL("../courses/python/", import.meta.url)) }];
      const course = await loadCourseSources(sources, host.files);
      const records = await LearningRecords.open(path.join(host.space.dataDir, "records.jsonl"), options.now);
      try {
        const connected = await (options.connect
          ? options.connect(records, course, host)
          : connectLearning(records, course, host, options.now, {
            beforeRestricted: () => host.abortAgent(TUTOR_AGENT),
          }));
        const tutor = await connectTutor(records, course, host, options.now);
        function state(): LearningState {
          const stored = records.current()?.state;
          if (stored) return { ...stored, serverNow: Date.now() };
          throw new RepaFault("service_failed", "教学初始状态尚未接入", { reason: "service_failure", service: "learning.flow", retryable: true });
        }
        const methods: Record<string, PluginMethod> = {
          "state.get": { parameters: learningMethods["state.get"].input, result: learningMethods["state.get"].result, invoke: async () => state() },
          "submission.get": {
            parameters: learningMethods["submission.get"].input, result: learningMethods["submission.get"].result,
            async invoke(input) {
              const { submissionId } = parse(learningMethods["submission.get"].input, input);
              const submission = records.submission(submissionId);
              return submission ? { status: "found", submission, revision: records.revision } : { status: "absent", submissionId, revision: records.revision };
            },
          },
          "submission.submit": {
            parameters: learningMethods["submission.submit"].input, result: learningMethods["submission.submit"].result,
            async invoke(input) {
              let receipt;
              try {
                receipt = await records.submit(parse(learningMethods["submission.submit"].input, input));
              } catch (error) {
                if (error instanceof RepaFault && error.code === "stale_state") throw new RepaFault("stale_state", error.message, { reason: "stale", state: state() });
                throw error;
              }
              if (receipt.status === "recorded") host.emit({ type: "learning.changed", revision: records.revision, taskId: state().task?.taskId ?? null, menuId: state().menu?.menuId ?? null, submissionId: receipt.submission.submissionId });
              return receipt;
            },
          },
          "submission.resume": {
            parameters: learningMethods["submission.resume"].input, result: learningMethods["submission.resume"].result,
            async invoke(input) {
              const { submissionId }: LearningInput<"submission.resume"> = parse(learningMethods["submission.resume"].input, input);
              const submission = records.submission(submissionId);
              if (!submission) throw new RepaFault("invalid_input", "找不到提交");
              if (submission.processing.status === "completed") return { status: "recorded", submission };
              throw new RepaFault("service_failed", "教学判分尚未接入，原答已保存", { reason: "service_failure", service: "learning.judge", retryable: true });
            },
          },
          ...connected?.methods,
          ...tutor.methods,
        };
        for (const [name, method] of Object.entries(methods)) {
          methods[name] = {
            ...method,
            async invoke(input, context) {
              try {
                const result = await method.invoke(input, context);
                return visibleLearningResponse(result, records.current());
              } catch (error) {
                if (error instanceof RepaFault) {
                  const details = visibleLearningResponse(error.details, records.current());
                  throw new RepaFault(error.code, error.message, details);
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
              await connected?.close?.();
            } finally {
              await records.close();
            }
          },
        };
      } catch (error) {
        await records.close();
        throw error;
      }
    },
  };
}
export default createLearningPlugin();
