import type { ToolDefinition, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { RepaFault } from "../errors.js";
import { RepresentationSchema, type ProcessingResult } from "../requests/schema.js";

/** Pi 用异常标记工具失败；tool_result 扩展保留异常携带的标准结果与资源。 */
export class ToolResults {
  readonly #failed = new Map<string, ProcessingResult>();

  wrap(tool: ToolDefinition): ToolDefinition {
    return {
      ...tool,
      execute: async (callId, input, signal, onUpdate, context) => {
        try { return await tool.execute(callId, input, signal, onUpdate, context); }
        catch (error) {
          if (error instanceof RepaFault && Check(RepresentationSchema, error.details))
            this.#failed.set(callId, error.details);
          throw error;
        }
      },
    };
  }

  finish(callId: string): ToolResultEventResult | undefined {
    const details = this.#failed.get(callId);
    this.#failed.delete(callId);
    return details ? { details } : undefined;
  }
}
